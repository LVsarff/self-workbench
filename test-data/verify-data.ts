/**
 * 测试数据自检脚本 — 在 gwd-workbench 目录执行：npx tsx test-data/verify-data.ts
 *
 * 用项目真实代码（csv-import / scoring / rule-config / content-agent schema /
 * similarity / banned-words）校验 test-data/ 下四类数据与代码内校验口径一致：
 *   分数与门槛预期、结构边界、坏数据跳行、规则校验拒绝、违禁词命中、去重相似度。
 * 全部通过 = 数据可直接进入验收流程；任何 FAIL 按提示修数据或修预期。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCandidatesCsv } from '../src/pipeline/csv-import.js';
import { scoreProduct, rankScored } from '../src/core/scoring.js';
import { RULE_V1, parseRuleConfig } from '../src/core/rule-config.js';
import { XiaohongshuNoteSchema, DouyinScriptSchema } from '../src/agent/content-agent.js';
import { jaccardSimilarity, DUPLICATE_SIMILARITY_THRESHOLD } from '../src/core/similarity.js';
import { checkBannedWords } from '../src/core/banned-words.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TD = (p: string) => join(HERE, p);

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`✗ FAIL  ${name}`, detail === undefined ? '' : detail);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ============================================================
// 1️⃣ 正常数据：candidates-normal.csv
// ============================================================
console.log('—— 1. 正常数据 ——');
const normal = parseCandidatesCsv(readFileSync(TD('01-normal/candidates-normal.csv'), 'utf8'));
eq('normal: 总行数 20', normal.stats.total, 20);
eq('normal: 全部有效 0 跳过', normal.stats.skipped, 0);

// 同 ID 后行覆盖（upsert 语义）
const byId = new Map(normal.rows.map((r) => [r.externalId, r]));
eq('normal: 唯一商品 19（含 1 条修正行覆盖）', byId.size, 19);
eq('normal: 修正行生效（洗脸巾销量 9200）', byId.get('35692147')!.sales30d, 9200);
eq('normal: 修正行生效（洗脸巾好评 98）', byId.get('35692147')!.reviewRate, 98);

const scored = [...byId.values()].map((s) => scoreProduct(s.externalId, s, RULE_V1));
const byScored = new Map(scored.map((p) => [p.snapshot.externalId, p]));

// 打分 / 门槛 / 完整性 预期表（按 RULE_V1 手算）
type Row = { total: number; grade: 'strong' | 'test' | 'drop' | null; gate: boolean; complete: boolean; flags?: string[] };
const normalExpected: Record<string, Row> = {
  '35692147': { total: 98, grade: 'strong', gate: true, complete: true }, // 榜首
  '63941758': { total: 88, grade: 'strong', gate: true, complete: true }, // ￥/千分位/涨 别名
  '78412563': { total: 86, grade: 'strong', gate: true, complete: true },
  '48219753': { total: 83, grade: 'strong', gate: true, complete: true, flags: ['环比缺失按持平'] },
  '90213547': { total: 80, grade: 'strong', gate: true, complete: true }, // 分级上临界
  '61587429': { total: 79, grade: 'test', gate: true, complete: true }, // 分级之下 1 分
  '51748392': { total: 77, grade: 'test', gate: true, complete: true }, // 环比 ↑ 别名
  '36985214': { total: 70, grade: 'test', gate: true, complete: true }, // 复购档位 1（最低档 2 分）
  '38574129': { total: 60, grade: 'test', gate: true, complete: true }, // 可测下临界（内容 2 档 + 竞争 2 档：5+8）
  '50248613': { total: 59, grade: 'drop', gate: true, complete: true }, // 放弃上临界
  '71548936': { total: 56, grade: 'drop', gate: true, complete: true }, // 环比下降
  '40875962': { total: 90, grade: 'strong', gate: false, complete: true }, // 类目禁售（打分独立于门槛）
  '67841259': { total: 68, grade: 'test', gate: false, complete: true }, // 预售履约
  '34125876': { total: 83, grade: 'strong', gate: false, complete: true }, // 佣金 15% ≤ 15 fail
  '76543198': { total: 71, grade: 'test', gate: false, complete: true }, // 好评 82 fail
  '95124738': { total: 71, grade: 'test', gate: false, complete: true, flags: ['品退率高供应链降档'] }, // 品退 13 fail
  '21983475': { total: 74, grade: 'test', gate: false, complete: true }, // 体验分 68 fail
  '58321476': { total: 55, grade: null, gate: true, complete: false }, // 三维全缺待评（15+20+10+10）
  '14785209': { total: 58, grade: null, gate: true, complete: false }, // 缺竞争度+复购待评
};
for (const [id, exp] of Object.entries(normalExpected)) {
  const p = byScored.get(id)!;
  eq(`normal ${id} total=${exp.total}`, p.total, exp.total);
  eq(`normal ${id} grade=${exp.grade}`, p.grade, exp.grade);
  eq(`normal ${id} gatePassed=${exp.gate}`, p.gatePassed, exp.gate);
  eq(`normal ${id} complete=${exp.complete}`, p.complete, exp.complete);
  if (exp.flags) {
    for (const f of exp.flags) ok(`normal ${id} flags 含「${f}」`, p.flags.includes(f), p.flags);
  }
}
// 六条门槛各被一条数据命中
const gateFailCodes = new Set(scored.filter((p) => !p.gatePassed).flatMap((p) => p.gates.filter((g) => g.status === 'fail').map((g) => g.code)));
for (const code of ['category', 'review_rate', 'return_rate', 'commission', 'merchant_score', 'fulfillment']) {
  ok(`normal: 六门槛之「${code}」被数据命中`, gateFailCodes.has(code), gateFailCodes);
}
// topN=5 截断：够格 11 个但 top5 固定
const { ranked } = rankScored(scored);
eq('normal: 排序资格品 11 个（gatePassed+complete）', ranked.length, 11, );
eq(
  'normal: top5 顺序（98/88/86/83/80）',
  ranked.slice(0, 5).map((p) => p.snapshot.externalId).join(','),
  '35692147,63941758,78412563,48219753,90213547',
);
// 待评标记
ok('normal: 58321476 待评标记', byScored.get('58321476')!.flags.some((f) => f.startsWith('待评:')), byScored.get('58321476')!.flags);
ok('normal: 14785209 待评只列缺失两项', byScored.get('14785209')!.flags.includes('待评:竞争度/复购扩展'), byScored.get('14785209')!.flags);

// ============================================================
// 2️⃣ 边界数据
// ============================================================
console.log('—— 2. 边界数据 ——');
const boundary = parseCandidatesCsv(readFileSync(TD('02-boundary/candidates-boundary.csv'), 'utf8'));
eq('boundary: 15 行全部有效', boundary.stats.valid, 15);
const bScored = new Map(boundary.rows.map((s) => [s.externalId, scoreProduct(s.externalId, s, RULE_V1)]));
const boundaryExpected: Record<string, { gate: boolean; total: number; grade: string | null; complete?: boolean; flags?: string[] }> = {
  '55010001': { gate: false, total: 65, grade: 'test' }, // 佣金 15.00 → fail（严格大于）
  '55010002': { gate: true, total: 65, grade: 'test' }, // 佣金 15.01 → pass
  '55010003': { gate: true, total: 65, grade: 'test' }, // 好评 85 → pass（销量 400 → 需求 10 分档）
  '55010004': { gate: false, total: 62, grade: 'test' }, // 好评 84.99 → fail，供应链跌至 3 分；62 仍 ≥ 可测线
  '55010005': { gate: true, total: 70, grade: 'test' }, // 品退 10 → pass（销量 600 → 需求 15 分档）
  '55010006': { gate: false, total: 67, grade: 'test', flags: ['品退率高供应链降档'] }, // 品退 10.01 → fail + 供应链降档至 3 分
  '55010007': { gate: true, total: 65, grade: 'test' }, // 体验分 70 → pass
  '55010008': { gate: false, total: 65, grade: 'test' }, // 体验分 69.9 → fail
  '55010009': { gate: true, total: 70, grade: 'test' }, // 价格 19.9 满分档；销量 1000 持平 → 需求 15
  '55010010': { gate: true, total: 65, grade: 'test' }, // 价格 19.89 落兜底 5 分档
  '55010011': { gate: true, total: 55, grade: 'drop' }, // 价格 0 + 销量 0（需求兜底 5 分）
  '55010012': { gate: true, total: 70, grade: 'test' }, // 价格 999999 兜底 5 分；销量 9999999 上升 → 需求 20
  '55010013': { gate: true, total: 52, grade: null, complete: false }, // 主观 0/6 → null 待评（15+15+10+6+6）
  '55010014': { gate: true, total: 74, grade: 'test' }, // 主观 1/5 端点（内容 3 + 竞争 15 + 复购 10）
  '55010015': { gate: true, total: 75, grade: 'test' }, // 销量 1000+up 满分档（20 分）
};
for (const [id, exp] of Object.entries(boundaryExpected)) {
  const p = bScored.get(id)!;
  eq(`boundary ${id} gate=${exp.gate}`, p.gatePassed, exp.gate);
  eq(`boundary ${id} total=${exp.total}`, p.total, exp.total);
  eq(`boundary ${id} grade=${exp.grade}`, p.grade, exp.grade);
  if (exp.complete !== undefined) eq(`boundary ${id} complete=${exp.complete}`, p.complete, exp.complete);
  if (exp.flags) for (const f of exp.flags) ok(`boundary ${id} flags 含「${f}」`, p.flags.includes(f), p.flags);
}
// 对比组：需求档 1000-up=20 vs 1000-flat=15（normal 48219753）
eq('boundary: 1000+up 需求 20 分 vs 1000 无环比 15 分',
  bScored.get('55010015')!.scores.demand - byScored.get('48219753')!.scores.demand, 5);

// 文本边界
const len = (p: string) => readFileSync(TD(p), 'utf8').trim().length;
eq('boundary: research-49 = 49 字符（拒绝下限）', len('02-boundary/research-49.txt'), 49);
eq('boundary: research-50 = 50 字符（恰好通过）', len('02-boundary/research-50.txt'), 50);
eq('boundary: research-8000 = 8000（不截断）', len('02-boundary/research-8000.txt'), 8000);
eq('boundary: research-8001 = 8001（触发截断）', len('02-boundary/research-8001.txt'), 8001);
eq('boundary: research-nul 剥 NUL 后 ≥50', readFileSync(TD('02-boundary/research-nul.txt'), 'utf8').replace(/\x00/g, '').trim().length, 64);
eq('boundary: note-500 = 500（截断上限内）', len('02-boundary/note-500.txt'), 500);
eq('boundary: note-510 = 510（触发 note 截断标记）', len('02-boundary/note-510.txt'), 510);
eq('boundary: research-flood = 20000（截断审计）', len('03-abnormal/research-flood.txt'), 20000);

// 文本结构边界（草稿 schema）
const bounds = JSON.parse(readFileSync(TD('02-boundary/content-draft-bounds.json'), 'utf8')) as {
  cases: Array<{ name: string; platform: 'xiaohongshu' | 'douyin'; expect: 'valid' | 'invalid'; draft: unknown }>;
};
for (const c of bounds.cases) {
  const schema = c.platform === 'xiaohongshu' ? XiaohongshuNoteSchema : DouyinScriptSchema;
  const r = schema.safeParse(c.draft);
  eq(`bounds: ${c.name} 期望 ${c.expect}`, r.success, c.expect === 'valid');
}
// 命名边界必须精确命中标称长度（防「上界用例其实没到上界」的漂移）
const bn = new Map(bounds.cases.map((c) => [c.name, c.draft as Record<string, unknown>]));
const strLen = (n: string, k: string) => String(bn.get(n)![k]).length;
const arrLen = (n: string, k: string) => (bn.get(n)![k] as unknown[]).length;
eq('bounds: xhs 标题下界 5 字', strLen('xhs-title-5chars-lower-bound', 'title'), 5);
eq('bounds: xhs 标题上界 20 字', strLen('xhs-title-20chars-upper-bound', 'title'), 20);
eq('bounds: xhs 正文下界 150 字', strLen('xhs-body-150chars-lower-bound', 'body'), 150);
eq('bounds: xhs 正文上界 500 字', strLen('xhs-body-500chars-upper-bound', 'body'), 500);
eq('bounds: xhs 标签上界 8 个', arrLen('xhs-tags-3-lower-and-8-upper', 'tags'), 8);
eq('bounds: xhs 标签越界 9 个', arrLen('xhs-tags-9-over-upper', 'tags'), 9);
eq('bounds: dy 钩子下界 5 字', strLen('dy-hook-5chars-lower-bound', 'hook'), 5);
eq('bounds: dy 钩子上界 30 字', strLen('dy-hook-30chars-upper-bound', 'hook'), 30);
eq('bounds: dy 卖点下界 2 条', arrLen('dy-points-2-lower-bound', 'points'), 2);
eq('bounds: dy 卖点上界 4 条', arrLen('dy-hook-30chars-upper-bound', 'points'), 4);
eq('bounds: dy cta 下界 5 字', strLen('dy-cta-5chars-lower-bound', 'cta'), 5);

// 特殊字符 CSV
const edge = parseCandidatesCsv(readFileSync(TD('02-boundary/candidates-edge-text.csv'), 'utf8'));
eq('edge: 3 行全部有效', edge.stats.valid, 3);
const edgeRows = new Map(edge.rows.map((r) => [r.externalId, r]));
ok('edge: 超长标题 >120（触发 prompt 截断）', edgeRows.get('55020001')!.title.length > 120, edgeRows.get('55020001')!.title.length);
ok('edge: emoji 标题保留', edgeRows.get('55020002')!.title.includes('🐱'));
eq('edge: 类目含逗号', edgeRows.get('55020003')!.category, '浴室,置物');
eq('edge: 履约含换行', edgeRows.get('55020003')!.fulfillment, '现货\n48小时内发货');
// 中英混合表头别名
const mixed = parseCandidatesCsv(readFileSync(TD('02-boundary/candidates-header-mixed.csv'), 'utf8'));
eq('mixed: 中英混合表头解析成功', mixed.stats.valid, 1);
eq('mixed: 字段映射正确', mixed.rows[0]!.externalId, '55020004');

// ============================================================
// 3️⃣ 异常数据
// ============================================================
console.log('—— 3. 异常数据 ——');
const broken = parseCandidatesCsv(readFileSync(TD('03-abnormal/candidates-broken.csv'), 'utf8'));
eq('broken: 16 行中 6 行有效', broken.stats.valid, 6);
eq('broken: 10 行跳过', broken.stats.skipped, 10);
eq(
  'broken: 错误行号（缺必填/数值解析失败）',
  broken.errors.map((e) => e.line).join(','),
  '2,3,4,5,6,7,8,9,10,17',
);
const brokenIds = new Set(broken.rows.map((r) => r.externalId));
eq('broken: 存活的是被 Number 接受的行', [...brokenIds].sort().join(','), '45610010,45610011,45610012,45610013,45610014,45610015');
eq('broken: 负价格 -10 原样入库（行为观察项）', broken.rows.find((r) => r.externalId === '45610010')!.price, -10);
eq('broken: 1e5 被接受为 100000（行为观察项）', broken.rows.find((r) => r.externalId === '45610011')!.sales30d, 100000);
ok('broken: SQL 注入仅作字面量标题入库', broken.rows.find((r) => r.externalId === '45610012')!.title.includes('DROP TABLE products'));
ok('broken: prompt 注入仅作字面量标题入库', broken.rows.find((r) => r.externalId === '45610013')!.title.includes('系统提示词'));
eq('broken: external_id 前后空格被 trim', brokenIds.has('45610014'), true);
eq('broken: 无法识别的环比按持平', broken.rows.find((r) => r.externalId === '45610015')!.momTrend, 'flat');

// 全错表头：3 行全跳
const hb = parseCandidatesCsv(readFileSync(TD('03-abnormal/candidates-header-broken.csv'), 'utf8'));
eq('header-broken: 未知表头 → 3 行全跳过', hb.stats.skipped, 3);
ok('header-broken: 每行报「缺必填字段」', hb.errors.every((e) => e.message.includes('缺必填字段')), hb.errors[0]?.message);

// 非法规则：4 份全部拒绝，且报错文案可定位
for (const [file, expectMsg] of [
  ['rule-invalid-total-99.json', '100'],
  ['rule-invalid-missing-tier.json', '档位 3'],
  ['rule-invalid-grading.json', 'testMin'],
  ['rule-invalid-schema.json', ''],
] as const) {
  const r = parseRuleConfig(JSON.parse(readFileSync(TD(`03-abnormal/${file}`), 'utf8')));
  ok(`rule-invalid: ${file} 被拒绝`, !r.ok, r.ok ? (r as { ok: true }).config : undefined);
  if (!r.ok && expectMsg !== '') ok(`rule-invalid: ${file} 报错含「${expectMsg}」`, r.errors.join(';').includes(expectMsg), r.errors);
}
// 合法 v2：通过
const v2 = parseRuleConfig(JSON.parse(readFileSync(TD('01-normal/rule-v2-valid.json'), 'utf8')));
ok('rule-v2-valid: 校验通过', v2.ok, v2.ok ? undefined : (v2 as { errors: string[] }).errors);

// 违禁词草稿种子复核（与 03-abnormal/seed-banned-draft.sql 内容一致）
const bannedXhsTitle = '全网最低价！这款拖把布太好用了';
const bannedXhsBody = '用了一个月来说说真实感受，100%好评不是吹的，这款拖把布吸水快不留水痕，拖完地秒干，家里有猫也不怕脚印。厚度比超市随手买的厚一倍，机洗几次没有变形起球。干拖吸头发湿拖去油渍，一面顶两面用。地板是浅色瓷砖，最怕水渍残留，用它拖完对着灯光看也没有水痕。拖杆接口也不晃，换布的时候按一下卡扣就行，不用弯腰。评论区催返场的不少，看后台数据它还是同品类的销量第一名。这个价位能用这个程度，日常拖地轻松了不少，拖地这件事终于不头疼了。';
const bannedDyHook = '全网第一的拖把布来了别再拖了';
eq('banned-seed: 小红书命中 4 词（「销量第一名」一词双中）', checkBannedWords(bannedXhsTitle + bannedXhsBody).join(','), '最低价,销量第一,第一名,100%');
eq('banned-seed: 抖音命中全网第一', checkBannedWords(bannedDyHook).join(','), '全网第一');
// 种子草稿本身结构合法（问题只在词表）
ok('banned-seed: 草稿结构合法（违规仅在词表命中）', XiaohongshuNoteSchema.safeParse({ title: bannedXhsTitle, body: bannedXhsBody, tags: ['居家清洁', '拖把布', '清洁好物'], coverIdea: null }).success);

// ============================================================
// 4️⃣ 组合数据
// ============================================================
console.log('—— 4. 组合数据 ——');
const day1 = parseCandidatesCsv(readFileSync(TD('04-combined/candidates-day1.csv'), 'utf8'));
const day2 = parseCandidatesCsv(readFileSync(TD('04-combined/candidates-day2.csv'), 'utf8'));
eq('combined: day1 12 行有效', day1.stats.valid, 12);
eq('combined: day2 12 行有效', day2.stats.valid, 12);
const ids1 = new Set(day1.rows.map((r) => r.externalId));
const ids2 = new Set(day2.rows.map((r) => r.externalId));
const carried = [...ids2].filter((id) => ids1.has(id));
eq('combined: 延续品 10 个（同 external_id 跨日复用）', carried.length, 10);
eq('combined: day2 消失品 2 个', [...ids1].filter((id) => !ids2.has(id)).sort().join(','), '33051742,88412536');
eq('combined: day2 新增品 2 个', [...ids2].filter((id) => !ids1.has(id)).sort().join(','), '72845936,95284617');
// 趋势演化
const d1 = new Map(day1.rows.map((r) => [r.externalId, r]));
const d2 = new Map(day2.rows.map((r) => [r.externalId, r]));
ok('combined: 洗脸巾销量 8600 → 9400（增长）', d2.get('35692147')!.sales30d! > d1.get('35692147')!.sales30d!);
eq('combined: 手机支架 up → down（趋势翻转）', `${d1.get('90213547')!.momTrend}→${d2.get('90213547')!.momTrend}`, 'up→down');
// 修正行：好评 93→94、价格 45→49
ok('combined: 硅藻泥脚垫修正（好评/价格更新）', d2.get('56127483')!.reviewRate! > d1.get('56127483')!.reviewRate! && d2.get('56127483')!.price! > d1.get('56127483')!.price!);
// day2 补齐三维后可入榜（day1 待评 → day2 complete）
const day1Pending = scoreProduct('58321476', d1.get('58321476')!, RULE_V1);
const day2Pending = scoreProduct('58321476', d2.get('58321476')!, RULE_V1);
ok('combined: 水槽网袋 day1 待评（三维缺）', !day1Pending.complete);
ok('combined: 水槽网袋 day2 补齐三维入榜（complete 且门槛过）', day2Pending.complete && day2Pending.gatePassed);

// 跨日去重：X/Y 相似命中、Z 不命中
const X = '厨房保鲜就用它！7件套硅胶盖真方便';
const Y = '厨房保鲜就用它！7件套硅胶盖真好用';
const Z = '换个思路聊剩菜保存的小妙招';
const simXY = jaccardSimilarity(X, Y);
ok(`combined: X/Y 相似度 ${simXY.toFixed(4)} ≥ 阈值 ${DUPLICATE_SIMILARITY_THRESHOLD}`, simXY >= DUPLICATE_SIMILARITY_THRESHOLD);
ok(`combined: seed 预填 0.7778 与实际一致（±0.02）`, Math.abs(simXY - 0.7778) < 0.02, simXY);
ok(`combined: X/Z 相似度低于阈值（换角度不误伤）`, jaccardSimilarity(X, Z) < DUPLICATE_SIMILARITY_THRESHOLD, jaccardSimilarity(X, Z));

// ============================================================
console.log(`\n结果：✅ ${passed} 项通过，❌ ${failed} 项失败`);
if (failed > 0) {
  process.exitCode = 1;
  console.error('\n有断言失败：请按 FAIL 行调整数据文件或预期表，再跑一次。');
} else {
  console.log('数据自检全部通过，可按 README-runbook.md 进入验收流程。');
}
