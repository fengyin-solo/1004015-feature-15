<template>
  <section class="page" data-module="trenchless">
    <header class="page-head">
      <div>
        <h2>非开挖修复管理</h2>
        <p class="page-desc">维护非开挖修复记录，围绕修复编号、修复管段、修复工艺、修复材料做登记、筛选与状态流转，并按工艺质量判定控制交付。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记非开挖修复记录</button>
        <button class="btn" type="button" @click="exportRows">导出非开挖修复清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="column === '质量判定'" class="judge-tag" :data-conclusion="row[column]">
              {{ row[column] }}
            </span>
            <span v-else-if="column === '判定依据'" class="judge-basis" :title="String(row[column])">
              {{ row[column] }}
            </span>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无非开挖修复数据，可先登记非开挖修复记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条非开挖修复记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="recheckRow" class="modal-mask" @click.self="closeRecheck">
      <div class="modal-box">
        <h3 class="modal-title">登记复检 — {{ recheckRow['修复编号'] }}（{{ recheckRow['修复管段'] }}）</h3>
        <p v-if="currentJudge" class="judge-line">
          当前判定：<strong>{{ currentJudge.conclusion }}</strong>
          （{{ currentJudge.source }}：{{ currentJudge.basis }}）
        </p>
        <div v-if="recheckHistory.length" class="recheck-history">
          <h4>历史复检 {{ recheckHistory.length }} 次（历史结论只追加、不覆盖）</h4>
          <ul>
            <li v-for="(item, index) in recheckHistory" :key="index">
              {{ item.日期 }} 结论「{{ item.结论 }}」：{{ item.说明 }}
              <br />原判定「{{ item.原判定 }}」，依据：{{ item.原判定依据 }}
            </li>
          </ul>
        </div>
        <div class="recheck-field">
          <span class="recheck-label">复检结论</span>
          <label v-for="option in recheckOptions" :key="option" class="recheck-option">
            <input v-model="recheckConclusion" type="radio" :value="option" />{{ option }}
          </label>
        </div>
        <label class="recheck-field">
          <span class="recheck-label">复检说明</span>
          <input v-model="recheckNote" placeholder="现场复检情况说明（与施工记录冲突时以现场复检为准）" />
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="submitRecheck">提交复检结论</button>
          <button class="btn ghost" type="button" @click="closeRecheck">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  recheckTrenchless,
  runAction as applyAction,
} from '@/api/local-service'
import { effectiveJudge, parseRecheckHistory } from '@/data/trenchless-quality'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('trenchless')
const columns = ["修复编号", "修复管段", "修复工艺", "修复材料", "施工日期", "修复长度", "修复效果", "质量判定", "判定依据"]
const actions = ["安排施工", "确认完成", "发起复检", "登记复检", "安排加固"]
const statuses = ["待施工", "施工中", "待复检", "需加固", "已完成"]
const recheckOptions = ["可交付", "需加固", "待复检"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待施工修复', value: rows.value.filter((row) => row.status === '待施工').length },
  { label: '施工中修复', value: rows.value.filter((row) => row.status === '施工中').length },
  { label: '已完成修复', value: rows.value.filter((row) => row.status === '已完成').length },
])

const recheckRow = ref<EntryRow | null>(null)
const recheckConclusion = ref('可交付')
const recheckNote = ref('')
const currentJudge = computed(() => (recheckRow.value ? effectiveJudge(recheckRow.value) : null))
const recheckHistory = computed(() =>
  recheckRow.value ? parseRecheckHistory(recheckRow.value['复检历史']) : [],
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '非开挖修复记录登记入口尚未接入审批流'
}

function openRecheck(row: EntryRow) {
  recheckRow.value = row
  recheckConclusion.value = '可交付'
  recheckNote.value = ''
}

function closeRecheck() {
  recheckRow.value = null
}

function submitRecheck() {
  if (!recheckRow.value) {
    return
  }
  const result = recheckTrenchless(
    Number(recheckRow.value.id),
    recheckConclusion.value,
    recheckNote.value,
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  recheckRow.value = null
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '登记复检') {
    openRecheck(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items.map((row) => {
      const judge = effectiveJudge(row)
      return { ...row, 质量判定: judge.conclusion, 判定依据: `${judge.source}：${judge.basis}` }
    })
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '非开挖修复列表读取失败'
  }
}

onMounted(reload)
</script>
