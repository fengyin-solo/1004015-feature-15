<template>
  <section class="page" data-module="trenchless">
    <header class="page-head">
      <div>
        <h2>非开挖修复管理</h2>
        <p class="page-desc">
          依据修复管段、工艺、材料、修复长度与施工日期做工艺质量判定（可交付 / 待复检 / 需加固 / 待补充），
          结论不满足时不能直接标记完成；现场复检以现场结论为准并保留施工记录原依据，复检台账只追加不覆盖。
        </p>
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

    <table class="data-table trenchless-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>工艺判定</th>
          <th>判定依据</th>
          <th>复检台账</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>
            <span v-if="verdictOf(row)" class="verdict-badge" :class="`verdict-${verdictClass(row)}`">
              {{ verdictOf(row) }}
            </span>
            <span v-else>—</span>
          </td>
          <td class="basis-cell" :title="basisOf(row)">{{ basisOf(row) || '—' }}</td>
          <td class="history-cell">
            <template v-if="historyOf(row).length">
              <p v-for="entry in historyOf(row)" :key="entry.复检日期 + entry.复检结论" class="history-line">
                <span>{{ entry.复检日期 }} {{ entry.复检结论 }}</span>
                <span v-if="entry.冲突处理.includes('冲突')" class="conflict-flag" :title="entry.冲突处理">现场为准</span>
              </p>
            </template>
            <span v-else>—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="muted-text">已交付</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无非开挖修复数据，可先登记非开挖修复记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条非开挖修复记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 现场复检弹窗：结论与施工记录冲突时以现场复检为准，原判断依据随台账保留 -->
    <div v-if="modal === 'reinspect'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3>现场复检登记 · {{ activeRow?.['修复编号'] }}</h3>
        <p class="modal-tip">
          施工记录判定：<strong>{{ verdictOf(activeRow!) }}</strong>
          （{{ basisOf(activeRow!) }}）
        </p>
        <label class="modal-field">
          <span>复检结论</span>
          <select v-model="reinspectForm.conclusion">
            <option value="复检通过">复检通过</option>
            <option value="复检不合格">复检不合格</option>
            <option value="暂缓结论">暂缓结论</option>
          </select>
        </label>
        <label class="modal-field">
          <span>复检日期</span>
          <input v-model="reinspectForm.date" type="date" />
        </label>
        <label class="modal-field">
          <span>现场情况说明</span>
          <textarea v-model="reinspectForm.note" rows="3" placeholder="记录现场复检发现，如 CCTV 复核、渗漏、错台等"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitReinspect">提交复检结论</button>
        </div>
      </div>
    </div>

    <!-- 旧记录缺少材料信息时按待补充处理：补齐后重新判定 -->
    <div v-if="modal === 'supplement'" class="modal-mask" @click.self="closeModal">
      <div class="modal-panel">
        <h3>补充关键信息 · {{ activeRow?.['修复编号'] }}</h3>
        <p class="modal-tip">旧记录缺少修复材料等关键信息，补齐前按「待补充」处理，不能流转与交付。</p>
        <label class="modal-field">
          <span>修复材料（必填）</span>
          <input v-model="supplementForm.修复材料" placeholder="如：树脂浸渍玻璃纤维软管" />
        </label>
        <label class="modal-field">
          <span>修复长度</span>
          <input v-model="supplementForm.修复长度" placeholder="如：120米；原值无法识别时补充" />
        </label>
        <label class="modal-field">
          <span>施工日期</span>
          <input v-model="supplementForm.施工日期" type="date" />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeModal">取消</button>
          <button class="btn primary" type="button" @click="submitSupplement">提交并重新判定</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  arrangeConstruction,
  confirmCompletion,
  registerReinforcement,
  submitOnsiteReinspection,
  submitReinspection as requestReinspection,
  supplementMaterial,
} from '@/api/trenchless-service'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { evaluateRepair, reinspectHistory, todayIso, type QualityVerdict } from '@/data/trenchless'
import type { EntryRow, ReinspectEntry } from '@/data/types'

const meta = moduleMeta('trenchless')
const columns = ["修复编号", "修复管段", "修复工艺", "修复材料", "施工日期", "修复长度", "修复效果", "修复状态"]
const allStatuses = ["待施工", "施工中", "待复检", "需加固", "待补充", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const modal = ref<'' | 'reinspect' | 'supplement'>('')
const activeRow = ref<EntryRow | null>(null)
const reinspectForm = ref({ conclusion: '复检通过', date: todayIso(), note: '' })
const supplementForm = ref({ 修复材料: '', 修复长度: '', 施工日期: '' })

const stats = computed(() => [
  { label: '待施工修复', value: countByStatus('待施工') },
  { label: '施工中修复', value: countByStatus('施工中') },
  {
    label: '待处置修复',
    value: rows.value.filter((row) => ['待复检', '需加固', '待补充'].includes(String(row.status))).length,
  },
  { label: '已完成修复', value: countByStatus('已完成') },
])

const statusSummary = computed(() =>
  allStatuses.map((status: string) => ({ status, count: countByStatus(status) })),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function displayCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || String(value).trim() === '') {
    return '—'
  }
  return String(value)
}

// 展示施工记录上一次流转保存的判定；待施工记录还没有判过时实时评估一次。
function decisionOf(row: EntryRow): { verdict: string; basis: string } {
  const storedVerdict = String(row['工艺判定'] ?? '').trim()
  const storedBasis = String(row['判定依据'] ?? '').trim()
  if (storedVerdict) {
    return { verdict: storedVerdict, basis: storedBasis }
  }
  const decision = evaluateRepair(row)
  return { verdict: decision.verdict, basis: decision.basis.join('；') }
}

function verdictOf(row: EntryRow | null): string {
  return row ? decisionOf(row).verdict : ''
}

function verdictClass(row: EntryRow): string {
  const verdict = verdictOf(row) as QualityVerdict | ''
  const map: Record<string, string> = {
    可交付: 'pass',
    待复检: 'pending',
    需加固: 'reinforce',
    待补充: 'missing',
  }
  return map[verdict] ?? 'pending'
}

function basisOf(row: EntryRow | null): string {
  return row ? decisionOf(row).basis : ''
}

function historyOf(row: EntryRow): ReinspectEntry[] {
  return reinspectHistory(row)
}

// 动作按状态给出；服务层会再做一次闸门校验，前端这里只负责呈现可尝试的操作。
function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待施工':
      return ['安排施工']
    case '施工中':
      return ['发起复检', '登记加固', '确认完成']
    case '待复检':
      return ['现场复检']
    case '需加固':
      return ['发起复检']
    case '待补充':
      return ['补充材料']
    default:
      return []
  }
}

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

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '现场复检') {
    activeRow.value = row
    reinspectForm.value = { conclusion: '复检通过', date: todayIso(), note: '' }
    modal.value = 'reinspect'
    return
  }
  if (action === '补充材料') {
    activeRow.value = row
    supplementForm.value = {
      修复材料: String(row['修复材料'] ?? ''),
      修复长度: String(row['修复长度'] ?? ''),
      施工日期: String(row['施工日期'] ?? ''),
    }
    modal.value = 'supplement'
    return
  }

  const id = Number(row.id)
  const result =
    action === '安排施工'
      ? arrangeConstruction(id)
      : action === '发起复检'
        ? requestReinspection(id)
        : action === '登记加固'
          ? registerReinforcement(id)
          : action === '确认完成'
            ? confirmCompletion(id)
            : { ok: false, message: `未登记动作「${action}」` }
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function submitReinspect() {
  if (!activeRow.value) return
  const result = submitOnsiteReinspection(Number(activeRow.value.id), {
    conclusion: reinspectForm.value.conclusion,
    date: reinspectForm.value.date,
    note: reinspectForm.value.note,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  closeModal()
  reload()
}

function submitSupplement() {
  if (!activeRow.value) return
  const result = supplementMaterial(Number(activeRow.value.id), {
    修复材料: supplementForm.value.修复材料,
    修复长度: supplementForm.value.修复长度,
    施工日期: supplementForm.value.施工日期,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  closeModal()
  reload()
}

function closeModal() {
  modal.value = ''
  activeRow.value = null
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '非开挖修复列表读取失败'
  }
}

onMounted(reload)
</script>
