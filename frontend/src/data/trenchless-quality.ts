import type { EntryRow, QualityJudge, RecheckRecord } from './types'

// 非开挖修复工艺质量判定：只依赖记录字段的纯函数，页面和服务层共用同一套规则。
// 结论分四档：可交付 / 待复检 / 需加固 / 待补充（旧记录缺材料时按待补充处理）。

const LOCAL_CRAFT_PATTERN = /局部|点状|补丁/
const BAD_EFFECT_PATTERN = /渗漏|开裂|脱落|未固化|破损/
const NEGATED_EFFECT_PATTERN = /无(渗漏|开裂|脱落|破损)/g
const MAX_LOCAL_LENGTH = 10
const MAX_DELIVER_LENGTH = 200
const RECHECK_YEARS = 3

function parseLength(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const match = String(value ?? '').match(/(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

function parseDate(value: string): Date | null {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time)
}

export function todayString(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 按修复管段、工艺、材料、修复长度、施工日期给出自动判定结论与依据。 */
export function judgeTrenchless(row: EntryRow, now: Date = new Date()): QualityJudge {
  const material = String(row['修复材料'] ?? '').trim()
  if (!material || material === '—' || material === '待补充') {
    return {
      conclusion: '待补充',
      basis: '修复材料信息缺失，按待补充处理，补齐材料后重新判定',
      source: '自动判定',
    }
  }
  const length = parseLength(row['修复长度'])
  if (length === null || length <= 0) {
    return {
      conclusion: '待复检',
      basis: '修复长度缺失或无法解析，需现场复检确认修复范围',
      source: '自动判定',
    }
  }
  const dateText = String(row['施工日期'] ?? '').trim()
  const constructionDate = parseDate(dateText)
  if (!constructionDate) {
    return {
      conclusion: '待复检',
      basis: '施工日期缺失或格式不正确，需现场复检核实施工时间',
      source: '自动判定',
    }
  }
  const ageYears = (now.getTime() - constructionDate.getTime()) / (365.25 * 24 * 3600 * 1000)
  if (ageYears > RECHECK_YEARS) {
    return {
      conclusion: '待复检',
      basis: `施工日期 ${dateText} 距今超过${RECHECK_YEARS}年，需现场复检确认当前质量状况`,
      source: '自动判定',
    }
  }
  const craft = String(row['修复工艺'] ?? '').trim()
  if (LOCAL_CRAFT_PATTERN.test(craft) && length > MAX_LOCAL_LENGTH) {
    return {
      conclusion: '需加固',
      basis: `局部修复工艺（${craft}）修复长度 ${length}m 超过 ${MAX_LOCAL_LENGTH}m 限值，需加固处理`,
      source: '自动判定',
    }
  }
  if (length > MAX_DELIVER_LENGTH) {
    return {
      conclusion: '需加固',
      basis: `修复长度 ${length}m 超过 ${MAX_DELIVER_LENGTH}m，整段需加固验收后方可交付`,
      source: '自动判定',
    }
  }
  const effect = String(row['修复效果'] ?? '')
  // 「无渗漏」这类否定表述不算质量隐患，先剔除再匹配。
  const positiveEffect = effect.replace(NEGATED_EFFECT_PATTERN, '')
  if (BAD_EFFECT_PATTERN.test(positiveEffect)) {
    return {
      conclusion: '需加固',
      basis: `施工记录修复效果为「${effect}」，存在质量隐患，需加固处理`,
      source: '自动判定',
    }
  }
  const segment = String(row['修复管段'] ?? '').trim() || '未登记管段'
  return {
    conclusion: '可交付',
    basis: `${segment}：工艺${craft}、材料${material}、长度${length}m、施工日期${dateText}均满足交付条件`,
    source: '自动判定',
  }
}

export function parseRecheckHistory(value: unknown): RecheckRecord[] {
  if (typeof value !== 'string' || value.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? (parsed as RecheckRecord[]) : []
  } catch {
    return []
  }
}

/** 生效判定：已有现场复检结论时以复检为准，否则用自动判定。 */
export function effectiveJudge(row: EntryRow, now: Date = new Date()): QualityJudge {
  const recheck = String(row['复检结论'] ?? '').trim()
  if (recheck) {
    return {
      conclusion: recheck,
      basis: String(row['复检说明'] ?? '').trim() || '现场复检结论',
      source: '现场复检',
    }
  }
  return judgeTrenchless(row, now)
}
