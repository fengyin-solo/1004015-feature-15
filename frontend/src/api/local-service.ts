import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { effectiveJudge, parseRecheckHistory, todayString } from '@/data/trenchless-quality'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 模块级扩展点：动作落库前的拦截（返回错误文案即拒绝）和落库后的联动。
const ACTION_GUARDS: Record<string, (row: EntryRow, action: string) => string | null> = {
  trenchless: (row, action) => {
    if (action === '确认完成') {
      const judge = effectiveJudge(row)
      if (judge.conclusion !== '可交付') {
        return `质量判定为「${judge.conclusion}」（${judge.source}：${judge.basis}），不满足交付条件，不允许直接标记完成`
      }
    }
    return null
  },
}

const AFTER_ACTIONS: Record<string, (row: EntryRow, action: string) => string | null> = {
  trenchless: (row, action) => {
    if (action === '确认完成') {
      const result = appendRepairHistory(
        String(row['修复管段']),
        buildRepairHistoryEntry(row, '确认完成'),
      )
      return result.message
    }
    return null
  },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const guard = ACTION_GUARDS[key]
  if (guard) {
    const rejected = guard(rows[index], action)
    if (rejected) {
      return { ok: false, message: rejected }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  let message = `${meta.entity}已${action}，当前状态「${target}」`
  const after = AFTER_ACTIONS[key]
  if (after) {
    const extra = after(updated, action)
    if (extra) {
      message += `；${extra}`
    }
  }
  return { ok: true, message }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 生成写进设施档案的一条修复履历。 */
function buildRepairHistoryEntry(row: EntryRow, trigger: string): string {
  const length = row['修复长度'] ?? '—'
  return (
    `${todayString()} ${trigger}：${row['修复编号']} `
    + `${row['修复工艺']}/${row['修复材料'] || '材料待补充'}/${length}m，判定可交付`
  )
}

function parseStringList(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** 复检通过后把修复履历追加到对应设施档案（按修复管段匹配设施名称），只增不改。 */
export function appendRepairHistory(facilityName: string, entry: string): ActionResult {
  const rows = listRows('facility_archive')
  const index = rows.findIndex((row) => String(row['设施名称']) === facilityName)
  if (index < 0) {
    return { ok: false, message: `设施档案中没有找到「${facilityName}」，修复履历未写入` }
  }
  const history = parseStringList(rows[index]['修复履历'])
  history.push(entry)
  const next = [...rows]
  next[index] = { ...rows[index], 修复履历: JSON.stringify(history) }
  saveRows('facility_archive', next)
  return { ok: true, message: `已更新「${facilityName}」的修复履历` }
}

/**
 * 登记现场复检结论：复检结论与施工记录（自动判定）冲突时以现场复检为准，
 * 原判断依据随本次复检一起写入历史，重复复检只追加、不覆盖历史结论。
 */
export function recheckTrenchless(id: number, conclusion: string, note: string): ActionResult {
  const rows = listRows('trenchless')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的非开挖修复记录` }
  }
  const row = rows[index]
  const status = String(row.status)
  if (status === '已完成') {
    return { ok: false, message: '该记录已交付，如需复检请先发起复检' }
  }
  if (status !== '待复检' && status !== '需加固') {
    return { ok: false, message: `当前状态为「${status}」，请先发起复检再登记复检结论` }
  }
  const current = effectiveJudge(row)
  const history = parseRecheckHistory(row['复检历史'])
  const trimmedNote = note.trim()
  history.push({
    日期: todayString(),
    结论: conclusion,
    说明: trimmedNote || '现场复检',
    原判定: current.conclusion,
    原判定依据: current.basis,
  })
  const conflict = current.conclusion !== conclusion
  const updated: EntryRow = {
    ...row,
    复检结论: conclusion,
    复检说明:
      trimmedNote
      || (conflict ? `现场复检与${current.source}「${current.conclusion}」不一致，以现场复检为准` : '现场复检确认'),
    复检历史: JSON.stringify(history),
  }
  let message = `复检结论「${conclusion}」已登记`
  if (conflict) {
    message += `，与${current.source}「${current.conclusion}」冲突，以现场复检为准，原判断依据已保留`
  }
  if (conclusion === '可交付') {
    updated.status = '已完成'
    updated.pending = false
    const archive = appendRepairHistory(
      String(row['修复管段']),
      buildRepairHistoryEntry(row, '复检通过'),
    )
    message += `，记录已标记完成；${archive.message}`
  } else if (conclusion === '需加固') {
    updated.status = '需加固'
    updated.pending = true
    message += '，记录转入需加固'
  } else {
    updated.status = '待复检'
    updated.pending = true
    message += '，记录保持待复检'
  }
  const next = [...rows]
  next[index] = updated
  saveRows('trenchless', next)
  return { ok: true, message }
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const trenchlessDone = (rows['trenchless'] ?? []).filter((row) => row.status === '已完成').length
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '已完成修复', value: trenchlessDone },
  ]
  return { cards, modules }
}
