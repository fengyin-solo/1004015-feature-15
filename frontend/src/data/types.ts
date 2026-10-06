/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

// 现场复检台账中的一条记录：复检只能追加，不能覆盖历史结论。
export type ReinspectEntry = {
  复检日期: string
  复检结论: string
  冲突处理: string
  原判断依据: string[]
  复检说明: string
}

export type EntryExtra =
  | string[]
  | ReinspectEntry[]
  | { [key: string]: string | string[] }

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | EntryExtra
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

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
