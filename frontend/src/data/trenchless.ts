import type { EntryRow, ReinspectEntry } from './types'

// 工艺质量判定的四档结论：
// 可交付：质量条件满足，允许标记完成并写进修复履历
// 待复检：条件有保留项（养护龄期不足、长距离等），需要现场复检后才能交付
// 需加固：材料与工艺不匹配或超出工艺适用能力，先加固处置再复检
// 待补充：旧记录或登记信息缺少材料等关键要素，补齐前不能流转
export type QualityVerdict = '可交付' | '待复检' | '需加固' | '待补充'

export type QualityDecision = {
  verdict: QualityVerdict
  basis: string[]
}

type ProcessRule = {
  keywords: string[]
  materialKeywords: string[]
  // 超过该长度（米）需要现场复检；超长（到加固阈值）则直接判需加固
  reinspectLength: number
  reinforceLength: number
  standardCuringDays: number
}

// 常见非开挖修复工艺的质量判定基准：材料、长度、养护龄期都在这里集中维护。
// 注意：关键字按顺序匹配，短关键字不能覆盖长工艺名（如「内衬」不能抢在「螺旋缠绕内衬」前）。
export const PROCESS_RULES: ProcessRule[] = [
  {
    keywords: ['紫外光固化', '紫外光原位固化', 'CIPP', '原位固化'],
    materialKeywords: ['树脂', '玻璃纤维', '软管', '浸渍'],
    reinspectLength: 100,
    reinforceLength: 300,
    standardCuringDays: 7,
  },
  {
    keywords: ['热水固化'],
    materialKeywords: ['树脂', '软管', '浸渍'],
    reinspectLength: 100,
    reinforceLength: 300,
    standardCuringDays: 7,
  },
  {
    keywords: ['螺旋缠绕'],
    materialKeywords: ['PVC', '型材', '带状'],
    reinspectLength: 100,
    reinforceLength: 260,
    standardCuringDays: 2,
  },
  {
    keywords: ['短管内衬', '穿插', 'U型折叠'],
    materialKeywords: ['PE', '聚乙烯', 'PVC', '管材'],
    reinspectLength: 80,
    reinforceLength: 200,
    standardCuringDays: 3,
  },
  {
    keywords: ['裂管', '胀管', '爆管'],
    materialKeywords: ['PE', '聚乙烯', '管材'],
    reinspectLength: 80,
    reinforceLength: 200,
    standardCuringDays: 3,
  },
  {
    keywords: ['点状修复', '双胀圈', '不锈钢发泡'],
    materialKeywords: ['不锈钢', '橡胶', '止水'],
    reinspectLength: 10,
    reinforceLength: 30,
    standardCuringDays: 1,
  },
]

function includesAny(text: string, keywords: string[]): boolean {
  const upper = text.toUpperCase()
  return keywords.some((keyword) => upper.includes(keyword.toUpperCase()))
}

function missingText(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || text === '—' || text.includes('样例')
}

function parseLength(value: unknown): number | null {
  const match = String(value ?? '').match(/\d+(\.\d+)?/)
  if (!match) {
    return null
  }
  return Number(match[0])
}

function parseDate(value: unknown): Date | null {
  const text = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return null
  }
  const date = new Date(`${text.slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function daysBetween(from: Date, to: Date): number {
  const dayMs = 24 * 60 * 60 * 1000
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((end - start) / dayMs)
}

export function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 依据修复管段、工艺、材料、修复长度、施工日期给出工艺质量结论。
// 评估日期默认取当天，复检页可以把施工日期当时的判断快照传进来对照。
export function evaluateRepair(row: EntryRow, evaluateDate: Date = new Date()): QualityDecision {
  const pipeSegment = String(row['修复管段'] ?? '').trim()
  const process = String(row['修复工艺'] ?? '').trim()
  const material = String(row['修复材料'] ?? '').trim()
  const rawLength = row['修复长度']
  const workDate = parseDate(row['施工日期'])

  // 旧记录缺少材料等关键信息时，按待补充处理，不允许凭经验直接放行。
  if (missingText(pipeSegment)) {
    return { verdict: '待补充', basis: ['缺少修复管段信息，需补充后重新判定'] }
  }
  if (missingText(material)) {
    return { verdict: '待补充', basis: ['旧记录缺少修复材料信息，按待补充处理，补齐材料后才能继续流转'] }
  }

  const rule = PROCESS_RULES.find((item) => includesAny(process, item.keywords))
  if (!rule) {
    return {
      verdict: '待复检',
      // 工艺不在标准库时没有材料匹配基准，不再以材料不符判加固，统一到现场复检确认。
      basis: [`工艺「${process || '未填写'}」未在标准工艺库中，需现场复检确认施工质量`],
    }
  }

  if (!includesAny(material, rule.materialKeywords)) {    return {
      verdict: '需加固',
      basis: [`修复材料「${material}」与工艺「${process}」不匹配，需要加固处置后复检`],
    }
  }

  const length = parseLength(rawLength)
  if (length === null) {
    return { verdict: '待补充', basis: ['修复长度未登记或无法识别，需补充长度数据后重新判定'] }
  }
  if (!workDate) {
    return { verdict: '待补充', basis: ['施工日期缺失或格式不正确，需补充后重新判定'] }
  }

  if (length > rule.reinforceLength) {
    return {
      verdict: '需加固',
      basis: [
        `修复长度 ${length} 米已超过「${process}」单次加固阈值 ${rule.reinforceLength} 米，需加固处置`,
      ],
    }
  }

  const retainReasons: string[] = []
  if (length > rule.reinspectLength) {
    retainReasons.push(
      `修复长度 ${length} 米超过「${process}」常规复检阈值 ${rule.reinspectLength} 米，需现场复检`,
    )
  }

  const curingDays = daysBetween(workDate, evaluateDate)
  if (curingDays < 0) {
    // 计划施工日期在未来：只按长度判定，养护龄期待施工后再核。
    if (retainReasons.length > 0) {
      return { verdict: '待复检', basis: retainReasons }
    }
    return {
      verdict: '可交付',
      basis: [
        `材料「${material}」符合「${process}」工艺要求`,
        `修复长度 ${length} 米在常规复检阈值 ${rule.reinspectLength} 米以内`,
      ],
    }
  }
  if (curingDays < rule.standardCuringDays) {
    retainReasons.push(
      `截至评估日养护龄期 ${curingDays} 天，未达到「${process}」标准养护期 ${rule.standardCuringDays} 天，需现场复检`,
    )
  }

  if (retainReasons.length > 0) {
    return { verdict: '待复检', basis: retainReasons }
  }

  return {
    verdict: '可交付',
    basis: [
      `材料「${material}」符合「${process}」工艺要求`,
      `修复长度 ${length} 米在常规复检阈值 ${rule.reinspectLength} 米以内`,
      `养护龄期 ${curingDays} 天已满足标准养护期 ${rule.standardCuringDays} 天`,
    ],
  }
}

export function reinspectHistory(row: EntryRow): ReinspectEntry[] {
  const history = row['复检记录']
  return Array.isArray(history) ? (history as ReinspectEntry[]) : []
}

export function hasFinalReinspection(row: EntryRow): boolean {
  return reinspectHistory(row).some((entry) => entry['复检结论'] === '复检通过')
}

export function isCompletedRepair(row: EntryRow): boolean {
  return String(row.status) === '已完成'
}

// 现场复检结论与施工记录判定冲突时，以现场复检为准；
// 同时返回是否发生冲突、以及当时施工记录的判断依据，原依据必须保留。
export function compareReinspection(
  decision: QualityDecision,
  onsiteConclusion: string,
): { conflict: boolean; effectiveVerdict: QualityVerdict; note: string } {
  if (onsiteConclusion === '复检通过') {
    const conflict = decision.verdict !== '可交付'
    return {
      conflict,
      effectiveVerdict: '可交付',
      note: conflict
        ? `现场复检结论（复检通过）与施工记录判定（${decision.verdict}）冲突，以现场复检为准；施工记录原判断依据已保留`
        : '现场复检通过，与施工记录判定一致',
    }
  }
  if (onsiteConclusion === '复检不合格') {
    return {
      conflict: false,
      effectiveVerdict: '需加固',
      note: '现场复检不合格，转加固处置，加固完成后重新复检',
    }
  }
  return {
    conflict: decision.verdict === '可交付',
    effectiveVerdict: '待复检',
    note: '现场复检暂缓，维持待复检',
  }
}
