// 非开挖修复质量判定全流程回归检查：
//   npx esbuild scripts/verify-trenchless.mts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/verify-trenchless.mjs && node /tmp/verify-trenchless.mjs
import { strict as assert } from 'node:assert'

// localStorage 替身，让数据层跑在 Node 里。
const store = new Map<string, string>()
// @ts-expect-error 模拟浏览器环境
globalThis.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } }

const { judgeTrenchless, effectiveJudge, parseRecheckHistory } = await import('../src/data/trenchless-quality')
const { runAction, recheckTrenchless, listEntries, loadOverview } = await import('../src/api/local-service')
const { SEED_ROWS } = await import('../src/data/seed')

// 1. 自动判定覆盖各分支
const [r1, r2, r3, r4, r5] = SEED_ROWS.trenchless
assert.equal(judgeTrenchless(r1).conclusion, '可交付', 'TREN-0001 应可交付')
assert.equal(judgeTrenchless(r2).conclusion, '需加固', 'TREN-0002 局部工艺超10m 需加固')
assert.equal(judgeTrenchless(r3).conclusion, '待补充', 'TREN-0003 缺材料按待补充')
assert.equal(judgeTrenchless(r4).conclusion, '待复检', 'TREN-0004 超3年待复检')
assert.equal(judgeTrenchless(r5).conclusion, '需加固', 'TREN-0005 超200m需加固')
console.log('✓ 1 自动判定五档分支正确')

// 2. 判定不满足时不允许直接标记完成
const blocked = runAction('trenchless', 2, '确认完成')
assert.equal(blocked.ok, false)
assert.match(blocked.message, /需加固/)
assert.match(blocked.message, /不允许直接标记完成/)
console.log('✓ 2 需加固记录确认完成被拦截：', blocked.message)

// 3. 可交付记录确认完成 → 设施档案履历更新
const done = runAction('trenchless', 1, '确认完成')
assert.equal(done.ok, true, done.message)
assert.match(done.message, /已更新「滨河路污水管段WS-0101~0102」的修复履历/)
const archive1 = listEntries('facility_archive').items.find((r) => r['设施名称'] === '滨河路污水管段WS-0101~0102')
const history1 = JSON.parse(String(archive1!['修复履历'])) as string[]
assert.equal(history1.length, 1)
assert.match(history1[0], /TREN-0001/)
assert.match(history1[0], /确认完成/)
console.log('✓ 3 确认完成后档案履历：', history1[0])

// 4. 复检与施工记录冲突：以现场复检为准，原判断依据保留
const conflict = recheckTrenchless(4, '需加固', '现场发现缠绕接口错位')
assert.equal(conflict.ok, true)
assert.match(conflict.message, /冲突/)
assert.match(conflict.message, /以现场复检为准/)
let row4 = listEntries('trenchless').items.find((r) => Number(r.id) === 4)!
assert.equal(row4.status, '需加固')
assert.equal(effectiveJudge(row4).conclusion, '需加固')
assert.equal(effectiveJudge(row4).source, '现场复检')
let hist4 = parseRecheckHistory(row4['复检历史'])
assert.equal(hist4.length, 1)
assert.equal(hist4[0].原判定, '待复检', '原判定保留')
assert.match(hist4[0].原判定依据, /超过3年/, '原判断依据保留')
console.log('✓ 4 冲突时以复检为准，原依据已留痕：', hist4[0].原判定依据)

// 5. 需加固状态确认完成仍被拦截（复检结论生效）
const stillBlocked = runAction('trenchless', 4, '确认完成')
assert.equal(stillBlocked.ok, false)
console.log('✓ 5 复检为需加固后仍不允许标记完成')

// 6. 重复复检：历史追加不覆盖；复检通过 → 已完成 + 档案履历 + 概览数量
const pass = recheckTrenchless(4, '可交付', '加固施工后复检合格')
assert.equal(pass.ok, true)
assert.match(pass.message, /记录已标记完成/)
row4 = listEntries('trenchless').items.find((r) => Number(r.id) === 4)!
assert.equal(row4.status, '已完成')
hist4 = parseRecheckHistory(row4['复检历史'])
assert.equal(hist4.length, 2, '重复复检追加历史')
assert.equal(hist4[0].结论, '需加固', '历史结论不被覆盖')
assert.equal(hist4[1].结论, '可交付')
const archive4 = listEntries('facility_archive').items.find((r) => r['设施名称'] === '文化路雨水管段YS-0407~0408')
const history4 = JSON.parse(String(archive4!['修复履历'])) as string[]
assert.equal(history4.length, 1)
assert.match(history4[0], /复检通过/)
const overview = loadOverview()
const doneCard = overview.cards.find((c) => c.label === '已完成修复')!
assert.equal(doneCard.value, 3, 'TREN-0001/0003/0004 已完成')
console.log('✓ 6 复检通过：档案履历、概览已完成修复数 =', doneCard.value)

// 7. 已交付记录不允许直接登记复检
const late = recheckTrenchless(4, '需加固', '事后反悔')
assert.equal(late.ok, false)
assert.match(late.message, /已交付/)
console.log('✓ 7 已交付记录登记复检被拒绝')

// 8. 未发起复检的记录不能登记复检
const early = recheckTrenchless(5, '可交付', '')
assert.equal(early.ok, false)
assert.match(early.message, /请先发起复检/)
console.log('✓ 8 未发起复检时登记复检被拒绝')

// 9. 旧记录缺材料 → 待补充；已完成的记录重复确认完成按既有规则拒绝
const legacy = runAction('trenchless', 3, '确认完成')
assert.equal(legacy.ok, false)
assert.match(legacy.message, /不用重复操作/)
assert.equal(judgeTrenchless(r3).conclusion, '待补充')
console.log('✓ 9 旧记录缺材料按待补充处理（TREN-0003 判定 =', judgeTrenchless(r3).conclusion, '）')

console.log('\n全部断言通过')
