import { listRows, saveRows } from '@/data/local-store'
import {
  compareReinspection,
  evaluateRepair,
  hasFinalReinspection,
  reinspectHistory,
  todayIso,
  type QualityVerdict,
} from '@/data/trenchless'
import type { ActionResult, EntryRow, ReinspectEntry } from '@/data/types'

export const TRENCHLESS_KEY = 'trenchless'
export const ARCHIVE_KEY = 'facility_archive'

// 只有「可交付」结论允许进入已完成；待复检/需加固/待补充一律拦截。
const DELIVERABLE: QualityVerdict[] = ['可交付']

function pendingOf(status: string): boolean {
  return status !== '已完成'
}

function abnormalOf(status: string): boolean {
  return status === '需加固' || status === '待补充'
}

function findRow(id: number): { rows: EntryRow[]; index: number } | ActionResult {
  const rows = listRows(TRENCHLESS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的非开挖修复记录` }
  }
  return { rows, index }
}

function persist(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveRows(TRENCHLESS_KEY, next)
}

function statusMessage(updated: EntryRow, action: string): ActionResult {
  return {
    ok: true,
    message: `非开挖修复记录已${action}，当前状态「${updated.status}」`,
  }
}

// 每次流转都把当时的工艺质量结论与判断依据留在记录上，作为施工记录的原始判断依据。
function withDecision(row: EntryRow, now: Date = new Date()): EntryRow {
  const decision = evaluateRepair(row, now)
  return {
    ...row,
    工艺判定: decision.verdict,
    判定依据: decision.basis.join('；'),
  }
}

export function arrangeConstruction(id: number): ActionResult {
  const found = findRow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const current = rows[index]
  if (String(current.status) !== '待施工') {
    return { ok: false, message: `只有「待施工」记录可以安排施工，当前状态「${current.status}」` }
  }
  const updated = withDecision({
    ...current,
    status: '施工中',
    pending: true,
    abnormal: false,
  })
  persist(rows, index, updated)
  return statusMessage(updated, '安排施工')
}

export function submitReinspection(id: number): ActionResult {
  const found = findRow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const current = rows[index]
  const status = String(current.status)
  if (!['施工中', '需加固'].includes(status)) {
    return {
      ok: false,
      message: `只有「施工中」或「需加固」记录可以发起复检，当前状态「${status}」`,
    }
  }
  // 判定为需加固的施工中记录，必须先走加固处置，不能直接发起复检跳过加固。
  if (status === '施工中' && evaluateRepair(current).verdict === '需加固') {
    return {
      ok: false,
      message: `工艺质量结论为「需加固」，请先登记加固处置，加固完成后再发起复检：${evaluateRepair(current).basis.join('；')}`,
    }
  }
  const updated = withDecision({
    ...current,
    status: '待复检',
    pending: true,
    abnormal: status === '需加固',
  })
  persist(rows, index, updated)
  return statusMessage(updated, '发起复检')
}

export function registerReinforcement(id: number): ActionResult {
  const found = findRow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const current = rows[index]
  const status = String(current.status)
  if (!['施工中', '待复检'].includes(status)) {
    return {
      ok: false,
      message: `当前状态「${status}」不需要登记加固，加固处置仅用于需加固的记录`,
    }
  }
  const decision = evaluateRepair(current)
  if (decision.verdict !== '需加固') {
    return {
      ok: false,
      message: `当前工艺质量结论为「${decision.verdict}」，不满足加固处置条件：${decision.basis.join('；')}`,
    }
  }
  const updated = withDecision({
    ...current,
    status: '需加固',
    pending: true,
    abnormal: true,
  })
  persist(rows, index, updated)
  return statusMessage(updated, '登记加固')
}

export function confirmCompletion(id: number): ActionResult {
  const found = findRow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const current = rows[index]
  const status = String(current.status)
  if (!['施工中', '待复检'].includes(status)) {
    return {
      ok: false,
      message: `当前状态「${status}」不能直接标记完成，请先完成相应处置与复检`,
    }
  }
  // 处于待复检流程的记录必须等现场复检通过，不允许绕过复检直接完成。
  if (status === '待复检' && !hasFinalReinspection(current)) {
    return { ok: false, message: '该记录处于待复检状态，需现场复检通过后才能标记完成' }
  }
  const decision = evaluateRepair(current)
  if (!DELIVERABLE.includes(decision.verdict)) {
    // 结论不满足时不允许直接标记完成。
    return {
      ok: false,
      message: `工艺质量结论为「${decision.verdict}」，不能标记完成：${decision.basis.join('；')}`,
    }
  }
  const updated = withDecision({
    ...current,
    status: '已完成',
    pending: false,
    abnormal: false,
  })
  persist(rows, index, updated)
  return statusMessage(updated, '确认完成')
}

export type ReinspectInput = {
  conclusion: string
  date?: string
  note?: string
}

// 现场复检：复检台账只追加不覆盖；冲突时以现场结论为准，施工记录原判断依据随台账一并保留。
export function submitOnsiteReinspection(id: number, input: ReinspectInput): ActionResult {
  const found = findRow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const current = rows[index]
  if (String(current.status) !== '待复检') {
    return { ok: false, message: `只有「待复检」记录可以登记现场复检，当前状态「${current.status}」` }
  }
  // 重复复检不能覆盖历史结论：已有通过结论的记录锁死，不再接受新的复检。
  if (hasFinalReinspection(current)) {
    return { ok: false, message: '该记录已有「复检通过」的历史结论，重复复检不能覆盖历史结论' }
  }

  const decision = evaluateRepair(current)
  const compared = compareReinspection(decision, input.conclusion)
  const entry: ReinspectEntry = {
    复检日期: input.date?.trim() || todayIso(),
    复检结论: input.conclusion,
    冲突处理: compared.note,
    原判断依据: decision.basis,
    复检说明: input.note?.trim() || '—',
  }

  let status: string
  if (compared.effectiveVerdict === '可交付') {
    status = '已完成'
  } else if (compared.effectiveVerdict === '需加固') {
    status = '需加固'
  } else {
    status = '待复检'
  }

  const updated: EntryRow = {
    ...current,
    status,
    pending: pendingOf(status),
    abnormal: abnormalOf(status),
    工艺判定: compared.effectiveVerdict,
    判定依据: decision.basis.join('；'),
    复检记录: [...reinspectHistory(current), entry],
  }
  persist(rows, index, updated)

  // 复检通过后更新设施档案页的修复履历。
  if (status === '已完成') {
    const archive = appendRepairHistory(updated, entry)
    if (archive.ok) {
      return {
        ok: true,
        message: `现场复检${input.conclusion === '复检通过' ? '通过' : '已登记'}，记录状态「${status}」；${archive.message}`,
      }
    }
    return {
      ok: true,
      message: `现场复检通过，记录状态「${status}」；但${archive.message}`,
    }
  }
  return statusMessage(updated, '登记现场复检')
}

// 旧记录缺少材料信息按待补充处理：补齐材料（长度/日期如需）后回到施工中重新判定。
export function supplementMaterial(
  id: number,
  patch: { 修复材料: string; 修复长度?: string; 施工日期?: string },
): ActionResult {
  const found = findRow(id)
  if ('ok' in found) return found
  const { rows, index } = found
  const current = rows[index]
  if (String(current.status) !== '待补充') {
    return { ok: false, message: `只有「待补充」记录需要补充材料，当前状态「${current.status}」` }
  }
  if (!patch.修复材料?.trim()) {
    return { ok: false, message: '修复材料为必填项，补齐后才能退出待补充状态' }
  }
  const merged: EntryRow = {
    ...current,
    修复材料: patch.修复材料.trim(),
    修复长度: patch.修复长度?.trim() || current['修复长度'],
    施工日期: patch.施工日期?.trim() || current['施工日期'],
  }
  const decision = evaluateRepair(merged)
  if (decision.verdict === '待补充') {
    const updated = withDecision({ ...merged, pending: true, abnormal: true })
    persist(rows, index, updated)
    return { ok: false, message: `材料已补充，但仍有关键信息缺失：${decision.basis.join('；')}` }
  }
  const updated = withDecision({
    ...merged,
    status: '施工中',
    pending: true,
    abnormal: false,
  })
  persist(rows, index, updated)
  return {
    ok: true,
    message: `材料等信息已补充，重新判定为「${decision.verdict}」，记录回到「施工中」`,
  }
}

function appendRepairHistory(repair: EntryRow, entry: ReinspectEntry): ActionResult {
  const segment = String(repair['修复管段'] ?? '').trim()
  const archives = listRows(ARCHIVE_KEY)
  const matches = archives.filter(
    (archive) =>
      String(archive['设施名称'] ?? '').includes(segment) ||
      segment.includes(String(archive['设施名称'] ?? '').trim()),
  )
  if (matches.length === 0) {
    return { ok: false, message: `设施档案中未找到管段「${segment}」对应的档案，修复履历未更新` }
  }

  // 长度字段本身可能带单位（如「120米」），归一成纯数字再拼履历，避免重复单位。
  const lengthText = String(repair['修复长度'] ?? '').replace(/米\s*$/, '')
  const summary =
    `${repair['修复编号']} ${repair['修复工艺']}/${repair['修复材料']} ` +
    `修复${lengthText}米，施工日期${repair['施工日期']}，` +
    `复检通过日期${entry.复检日期}`

  const next = archives.map((archive) => {
    if (!matches.includes(archive)) return archive
    const historyValue = archive['修复履历']
    const history = Array.isArray(historyValue) ? (historyValue as string[]) : []
    return {
      ...archive,
      status: '待更新',
      pending: true,
      修复履历: [...history, summary],
    }
  })
  saveRows(ARCHIVE_KEY, next)
  return { ok: true, message: `已更新 ${matches.length} 份设施档案的修复履历` }
}

export function completedRepairCount(): number {
  return listRows(TRENCHLESS_KEY).filter((row) => String(row.status) === '已完成').length
}
