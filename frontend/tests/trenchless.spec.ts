/* 非开挖修复工艺质量判定 + 状态机 + 复检台账 + 档案履历联动的端到端验证。
   运行：npm test（通过 esbuild 即时打包为 Node ESM，无需额外测试框架）。 */
import { compareReinspection, evaluateRepair } from '@/data/trenchless'
import {
  arrangeConstruction,
  confirmCompletion,
  registerReinforcement,
  submitOnsiteReinspection,
  submitReinspection,
  supplementMaterial,
  completedRepairCount,
} from '@/api/trenchless-service'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

// 固定评估日，避免养护龄期随真实日期漂移
const evalDate = new Date('2026-10-06T12:00:00')
function evalRow(over: Partial<EntryRow>): EntryRow {
  return {
    id: 999,
    status: '施工中',
    pending: true,
    abnormal: false,
    修复编号: 'T',
    修复管段: '测试管段',
    修复工艺: '紫外光原位固化',
    修复材料: '树脂浸渍玻璃纤维软管',
    施工日期: '2026-09-25',
    修复长度: '60米',
    ...over,
  }
}

console.log('1) 工艺质量判定')
check('材料/长度/养护都满足 → 可交付', evaluateRepair(evalRow({}), evalDate).verdict === '可交付')
check(
  '养护龄期不足 → 待复检',
  evaluateRepair(evalRow({ 施工日期: '2026-10-04' }), evalDate).verdict === '待复检',
)
check(
  '长距离（>100 且 <=300）→ 待复检',
  evaluateRepair(evalRow({ 修复长度: '120米' }), evalDate).verdict === '待复检',
)
check(
  '超长（>300）→ 需加固',
  evaluateRepair(evalRow({ 修复长度: '320米' }), evalDate).verdict === '需加固',
)
check(
  '材料与工艺不匹配 → 需加固',
  evaluateRepair(evalRow({ 修复材料: '水泥注浆料' }), evalDate).verdict === '需加固',
)
check(
  '旧记录缺材料 → 待补充',
  evaluateRepair(evalRow({ 修复材料: '' }), evalDate).verdict === '待补充',
)
check(
  '材料为占位样例文本 → 待补充',
  evaluateRepair(evalRow({ 修复材料: '非开挖修复样例1' }), evalDate).verdict === '待补充',
)
check(
  '长度无法识别 → 待补充',
  evaluateRepair(evalRow({ 修复长度: '未知' }), evalDate).verdict === '待补充',
)
check(
  '未来施工日期不按养护拦截，短段可交付',
  evaluateRepair(evalRow({ 施工日期: '2026-10-10' }), evalDate).verdict === '可交付',
)
check(
  '未来施工日期 + 超长 → 待复检（长度仍适用）',
  evaluateRepair(evalRow({ 施工日期: '2026-10-10', 修复长度: '150米' }), evalDate).verdict === '待复检',
)
check(
  '未知工艺 → 待复检',
  evaluateRepair(evalRow({ 修复工艺: '玻璃纤维布喷涂（试点工艺）' }), evalDate).verdict === '待复检',
)
check(
  '缺修复管段 → 待补充',
  evaluateRepair(evalRow({ 修复管段: '' }), evalDate).verdict === '待补充',
)
check(
  '短管内衬 PE 材料匹配 → 可交付',
  evaluateRepair(evalRow({ 修复工艺: '短管内衬修复', 修复材料: 'PE100管材', 施工日期: '2026-10-01' }), evalDate).verdict === '可交付',
)
check(
  '点状修复养护1天即可',
  evaluateRepair(
    evalRow({ 修复工艺: '点状修复（双胀圈）', 修复材料: '不锈钢双胀圈橡胶止水套环', 修复长度: '2.5米', 施工日期: '2026-10-05' }),
    evalDate,
  ).verdict === '可交付',
)

console.log('2) 冲突处理：以现场复检为准且保留原依据')
{
  const decision = evaluateRepair(evalRow({ 施工日期: '2026-10-04' }), evalDate)
  const cmp = compareReinspection(decision, '复检通过')
  check('待复检记录现场复检通过 → 冲突标记', cmp.conflict === true)
  check('现场通过后生效结论 → 可交付', cmp.effectiveVerdict === '可交付')
  check('冲突说明含「以现场复检为准」', cmp.note.includes('以现场复检为准'))
  const decision2 = evaluateRepair(evalRow({ 修复材料: '水泥注浆料' }), evalDate)
  const cmp2 = compareReinspection(decision2, '复检不合格')
  check('现场复检不合格 → 需加固', cmp2.effectiveVerdict === '需加固')
}

console.log('3) 状态机闸门（基于种子数据）')
{
  const id1 = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0001')!.id
  check('TREN-0001 待施工直接确认完成 → 拒绝', !confirmCompletion(id1).ok)
  const arranged = arrangeConstruction(id1)
  check('安排施工成功', arranged.ok, arranged.message)
  const done = confirmCompletion(id1)
  check('结论可交付 → 允许确认完成', done.ok, done.message)
}

{
  // TREN-0002：养护不足 → 施工中确认完成被拦截；现场复检通过（冲突）→ 完成+履历
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0002')!.id
  const blocked = confirmCompletion(id)
  check('待复检结论直接确认完成 → 拒绝', !blocked.ok && blocked.message.includes('不能标记完成'), blocked.message)
  const reinspectRequested = submitReinspection(id)
  check('施工中可发起复检', reinspectRequested.ok, reinspectRequested.message)
  const pass = submitOnsiteReinspection(id, {
    conclusion: '复检通过',
    date: '2026-10-06',
    note: 'CCTV 复核正常',
  })
  check('现场复检通过 → ok 且更新档案', pass.ok && pass.message.includes('设施档案'), pass.message)
  const row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('复检通过后状态 → 已完成', String(row.status) === '已完成')
  const entry = (row['复检记录'] as Array<Record<string, unknown>>)[0]
  check('台账保留原判断依据（养护不足）', (entry['原判断依据'] as string[]).some((b) => b.includes('养护龄期')))
  check('冲突处理说明已记录', String(entry['冲突处理']).includes('以现场复检为准'))
  const repeat = submitOnsiteReinspection(id, { conclusion: '复检通过' })
  check('重复复检不能覆盖历史结论 → 拒绝', !repeat.ok, repeat.message)
  const archives = listRows('facility_archive').filter((a) => String(a['设施名称']).includes('解放路-和平里'))
  check('设施档案状态 → 待更新', archives.length === 1 && String(archives[0].status) === '待更新')
  check(
    '修复履历已追加一条',
    archives.length === 1 && (archives[0]['修复履历'] as string[]).length === 1,
  )
}

{
  // TREN-0003：可交付，施工中直接确认完成（不经过复检 → 不写履历）
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0003')!.id
  const ok = confirmCompletion(id)
  check('TREN-0003 可交付 → 直接完成', ok.ok, ok.message)
  const archives = listRows('facility_archive').filter((a) => String(a['设施名称']).includes('建设大街'))
  check(
    '直接确认完成不写档案履历',
    archives.length === 1 && (archives[0]['修复履历'] as string[]).length === 0,
  )
}

{
  // TREN-0004：材料不匹配 → 需加固；登记加固→复检→不合格→再加固→复检通过
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0004')!.id
  check('需加固结论确认完成 → 拒绝', !confirmCompletion(id).ok)
  const directReinspect = submitReinspection(id)
  check('需加固未登记加固直接发起复检 → 拒绝', !directReinspect.ok, directReinspect.message)
  const reinforced = registerReinforcement(id)
  check('登记加固成功', reinforced.ok, reinforced.message)
  let row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('登记加固后状态 → 需加固', String(row.status) === '需加固' && row.abnormal === true)
  const requested = submitReinspection(id)
  check('加固后发起复检成功', requested.ok, requested.message)
  const fail = submitOnsiteReinspection(id, { conclusion: '复检不合格', date: '2026-10-06', note: '仍渗漏' })
  check('现场复检不合格 → 回需加固', fail.ok, fail.message)
  row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('不合格后状态 → 需加固', String(row.status) === '需加固')
  check('不合格台账已追加', (row['复检记录'] as unknown[]).length === 1)
  submitReinspection(id)
  const pass = submitOnsiteReinspection(id, { conclusion: '复检通过', date: '2026-10-08', note: '注浆加固后无渗漏' })
  check('加固后复检通过 → 完成', pass.ok, pass.message)
  row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('台账累积两条，未被覆盖', (row['复检记录'] as unknown[]).length === 2)
  check('最终状态 → 已完成', String(row.status) === '已完成')
}

{
  // TREN-0005：旧记录缺材料 → 待补充；补齐后重新判定
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0005')!.id
  check('待补充记录确认完成 → 拒绝', !confirmCompletion(id).ok)
  const empty = supplementMaterial(id, { 修复材料: '' })
  check('补充为空 → 拒绝', !empty.ok)
  const sup = supplementMaterial(id, { 修复材料: '树脂浸渍玻璃纤维软管' })
  check('补齐材料 → 回到施工中并重新判定', sup.ok, sup.message)
  let row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('补齐后状态 → 施工中', String(row.status) === '施工中')
  check('补齐后长度120米 → 待复检结论', String(row['工艺判定']) === '待复检', String(row['工艺判定']))
  submitReinspection(id)
  const pass = submitOnsiteReinspection(id, { conclusion: '复检通过', date: '2026-10-06' })
  check('补材料后复检通过 → 完成', pass.ok, pass.message)
  row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('材料已写入记录', String(row['修复材料']) === '树脂浸渍玻璃纤维软管')
}

{
  // 已完成修复计数：初始仅 TREN-0008，流程中又完成 5 条
  const initialCompleted = 1
  const afterFlows = completedRepairCount()
  console.log(`  info: completedRepairCount=${afterFlows}（初始 ${initialCompleted}，本次流程新增5条）`)
  check('已完成修复数量随复检/完成动作增加', afterFlows === initialCompleted + 5, `实际 ${afterFlows}`)
}

{
  // TREN-0009 未知工艺待复检：暂缓结论维持待复检，暂缓后还能继续复检
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0009')!.id
  const hold = submitOnsiteReinspection(id, { conclusion: '暂缓结论', date: '2026-10-06', note: '待补充检测资料' })
  check('暂缓结论 → 维持待复检', hold.ok, hold.message)
  const row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('状态仍为待复检', String(row.status) === '待复检')
  check('台账已追加一条暂缓记录', (row['复检记录'] as unknown[]).length === 1)
  const pass = submitOnsiteReinspection(id, { conclusion: '复检通过', date: '2026-10-07' })
  check('暂缓后复检通过 → 完成', pass.ok, pass.message)
  check('台账累积两条', (listRows('trenchless').find((r) => Number(r.id) === id)!['复检记录'] as unknown[]).length === 2)
}

{
  // TREN-0006 超长需加固且无匹配档案：复检通过给档案未匹配警告但不阻断
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0006')!.id
  check('TREN-0006 超长 → 需加固结论，不能完成', !confirmCompletion(id).ok)
  check('登记加固', registerReinforcement(id).ok)
  check('加固后发起复检', submitReinspection(id).ok)
  const pass = submitOnsiteReinspection(id, { conclusion: '复检通过', date: '2026-10-06' })
  check('档案未匹配时复检仍通过但带提示', pass.ok && pass.message.includes('未找到'), pass.message)
  check('复检后状态 → 已完成', String(listRows('trenchless').find((r) => Number(r.id) === id)!.status) === '已完成')
}

{
  // TREN-0007：已有一条不合格历史，加固后复检通过与历史共存
  const id = listRows('trenchless').find((r) => String(r['修复编号']) === 'TREN-0007')!.id
  check('需加固状态发起复检可用', submitReinspection(id).ok)
  const pass = submitOnsiteReinspection(id, { conclusion: '复检通过', date: '2026-10-06', note: '端部已注浆' })
  check('加固管段复检通过 → 完成', pass.ok, pass.message)
  const row = listRows('trenchless').find((r) => Number(r.id) === id)!
  check('历史不合格 + 新通过台账共存（2条）', (row['复检记录'] as unknown[]).length === 2)
  check('重复复检 → 拒绝', !submitOnsiteReinspection(id, { conclusion: '复检通过' }).ok)
  const archive = listRows('facility_archive').find((a) => String(a['设施名称']).includes('老城区-北关'))!
  check('档案履历追加1条（初始为空）', (archive['修复履历'] as string[]).length === 1)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
