/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 非开挖修复的质量判定结论：可交付 / 待复检 / 需加固 / 待补充。 */
export type QualityJudge = {
  conclusion: string
  basis: string
  source: '自动判定' | '现场复检'
}

/** 一次现场复检的留痕：原判断依据随记录一起保留，历史结论不可覆盖。 */
export type RecheckRecord = {
  日期: string
  结论: string
  说明: string
  原判定: string
  原判定依据: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
