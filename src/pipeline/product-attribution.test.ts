/**
 * 品级成交归因（模块⑤ 5/5）测试。
 * 关键语义：
 *   - join 锚点：publish_records（按品聚合，首条发布日 = 窗口起点）↔ product_performance(source='manual').product_id
 *   - 窗口：首条发布日（上海时区）+ N-1 天，窗外行不计入
 *   - 无内容维度：成交不分配到单条内容（gmvPerContent 仅参考）
 *   - 不猜：点击 0 → 加购率/成交转化率 null（不是 0%）
 *   - 小样本护栏：品级已发布内容 <2 条 → sampleSufficient=false
 *   - 未归因清单：noPerfData / outOfWindow / perfNoPublish（后台有品、发布台账无）逐条给原因
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import type { ProductPerfRow, SimContentStatRow, SimSource } from '../db/repo.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { runDailyScan } from './daily-scan.js';
import { selectProducts } from './select.js';
import { runContentGen } from './content-gen.js';
import { confirmContentDraft } from './content-confirm.js';
import { recordPublish, syncPublishQueue } from './publish.js';
import { buildProductAttribution, DEFAULT_PRODUCT_ATTRIBUTION_DAYS } from './product-attribution.js';

const DATE = '2026-01-05';
const ALL_TRUE = [true, true, true, true, true];
/** 上海 '2026-01-05 10:00'（入队时间） */
const NOW_10 = new Date('2026-01-05T02:00:00Z');
/** 上海 '2026-01-05 21:00'（发布时间） */
const PUBLISHED_AT = '2026-01-05T13:00:00.000Z';

function snap(externalId: string, overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    externalId,
    title: `商品${externalId}`,
    category: '家居收纳',
    price: 39.9,
    commissionRate: 25,
    sales30d: 3200,
    momTrend: 'up',
    reviewRate: 96,
    returnRate: 2,
    merchantScore: 85,
    fulfillment: '现货',
    contentFriendliness: 5,
    competition: 4,
    repurchase: 5,
    imageUrl: null,
    ...overrides,
  };
}

/** 商品层「商品-日」行（source 类型锁死 manual——本表永远无模拟形态） */
function perf(productId: string, statDate: string, o: Partial<ProductPerfRow> = {}): ProductPerfRow {
  return {
    source: 'manual',
    productId,
    statDate,
    productTitle: `商品${productId}`,
    category: null,
    clickCnt: 0,
    addCartCnt: 0,
    orderCnt: 0,
    gmvAmount: 0,
    commissionAmount: 0,
    ...o,
  };
}

/** 表现数据：vx1/vx2 窗口内有数据（内容层归因用，这里仅造最小集） */
function stat(source: SimSource, videoId: string, statDate: string, o: Partial<SimContentStatRow> = {}): SimContentStatRow {
  return {
    source, videoId, authorId: 'me', statDate,
    videoType: null, uploadDt: null, videoDuration: null, videoTagName: null,
    showCnt: 0, playCnt: 0, completePlayCnt: 0, likeCnt: 0, commentCnt: 0, shareCnt: 0,
    followCnt: 0, collectCnt: 0, reportCnt: 0, caption: null, topicTag: null, category: null, ...o,
  };
}

/** 四条记录全部发布（A/xhs · A/douyin · B/xhs · B/douyin；发布时间可按品错开） */
async function publishedRepo(publishedAtByPlatform: Record<string, string> = {}): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B')], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
  await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
  for (const [id, platform] of [
    ['A', 'xiaohongshu'],
    ['A', 'douyin'],
    ['B', 'xiaohongshu'],
    ['B', 'douyin'],
  ] as const) {
    await confirmContentDraft({ repo, date: DATE, externalId: id, platform, answers: ALL_TRUE });
  }
  await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
  const at = (platform: string): string => publishedAtByPlatform[platform] ?? PUBLISHED_AT;
  await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: at('A/xhs') });
  await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'douyin', url: 'https://v.douyin.com/a', publishedAt: at('A/dy') });
  await recordPublish({ repo, date: DATE, externalId: 'B', platform: 'xiaohongshu', url: 'https://xhs.link/b', publishedAt: at('B/xhs') });
  await recordPublish({ repo, date: DATE, externalId: 'B', platform: 'douyin', url: 'https://v.douyin.com/b', publishedAt: at('B/dy') });
  return repo;
}

describe('buildProductAttribution：join / 窗口 / 汇总（零 LLM）', () => {
  it('窗口内累计 + 率值口径 + 均摊 + 排序（GMV 降序）+ 内容清单', async () => {
    const repo = await publishedRepo();
    await repo.upsertProductStats([
      // A：窗口内 2 天 + 窗外各 1 天（01-04 早于首发 / 12-06 晚于默认 30 天窗口）
      perf('A', '2026-01-05', { clickCnt: 200, addCartCnt: 30, orderCnt: 8, gmvAmount: 319.2, commissionAmount: 79.8 }),
      perf('A', '2026-01-06', { clickCnt: 120, addCartCnt: 15, orderCnt: 4, gmvAmount: 159.6, commissionAmount: 39.9 }),
      perf('A', '2026-01-04', { gmvAmount: 999 }),
      perf('A', '2026-12-06', { gmvAmount: 888 }),
      // B：点击 0（除零护栏：率值 → null 不是 0%）
      perf('B', '2026-01-06', { clickCnt: 0, addCartCnt: 0, orderCnt: 0, gmvAmount: 0, commissionAmount: 0 }),
    ]);
    const report = await buildProductAttribution({ repo });

    expect(report.days).toBe(DEFAULT_PRODUCT_ATTRIBUTION_DAYS); // 默认 30（成交周期长于内容表现）
    expect(report.disclaimer).toContain('真实通道');
    expect(report.disclaimer).toContain('无内容维度');

    const a = report.products.find((p) => p.externalId === 'A')!;
    expect(a.contentCount).toBe(2);
    expect(a.platforms).toEqual(['douyin', 'xiaohongshu']); // 确定性输出：字母序
    expect(a.windowFrom).toBe('2026-01-05');
    expect(a.windowTo).toBe('2026-02-03'); // 首发 + 29 天
    expect(a.statDays).toBe(2); // 窗外 2 行不计入
    expect(a.totals.clickCnt).toBe(320);
    expect(a.totals.addCartCnt).toBe(45);
    expect(a.totals.orderCnt).toBe(12);
    expect(a.totals.gmvAmount).toBe(478.8);
    expect(a.totals.commissionAmount).toBe(119.7);
    expect(a.addCartRate).toBeCloseTo(45 / 320);
    expect(a.orderRate).toBeCloseTo(12 / 320);
    expect(a.gmvPerContent).toBeCloseTo(478.8 / 2);
    expect(a.sampleSufficient).toBe(true); // 2 条内容
    expect(a.contents).toHaveLength(2);
    expect(a.contents.every((c) => c.videoId == null)).toBe(true); // 演示 fixture 未回填 video_id，如实为 null

    const b = report.products.find((p) => p.externalId === 'B')!;
    expect(b.totals.clickCnt).toBe(0);
    expect(b.addCartRate).toBeNull(); // 不猜
    expect(b.orderRate).toBeNull();
    expect(b.gmvPerContent).toBe(0);
    expect(b.sampleSufficient).toBe(true); // B 也有 2 条内容

    expect(report.products.map((p) => p.externalId)).toEqual(['A', 'B']); // GMV 降序
  });

  it('首条发布日 = 窗口起点：品内两条内容不同日发布，取最早', async () => {
    // B 品 xhs 早发布（01-05），douyin 晚发布（01-10）→ 窗口从 01-05 起
    const repo = await publishedRepo({ 'B/xhs': '2026-01-05T13:00:00.000Z', 'B/dy': '2026-01-10T13:00:00.000Z' });
    await repo.upsertProductStats([
      perf('B', '2026-01-06', { clickCnt: 10, orderCnt: 1, gmvAmount: 39.9 }), // 在窗口内（起点 01-05）
      perf('B', '2026-01-09', { clickCnt: 5, orderCnt: 0, gmvAmount: 0 }), // 01-10 发布的那条之前的日行，仍在窗口内
    ]);
    const report = await buildProductAttribution({ repo, days: 5 });
    const b = report.products.find((p) => p.externalId === 'B')!;
    expect(b.windowFrom).toBe('2026-01-05');
    expect(b.windowTo).toBe('2026-01-09');
    expect(b.statDays).toBe(2);
    expect(b.totals.clickCnt).toBe(15);
  });

  it('未归因清单三类逐条给原因：noPerfData / outOfWindow / perfNoPublish', async () => {
    const repo = await publishedRepo();
    await repo.upsertProductStats([
      // A：完全无行 → noPerfData
      // B：有历史行但全在窗口外（发布时间填错形态）
      perf('B', '2025-12-01', { gmvAmount: 100 }),
      // 外部品：后台有成交、发布台账无该品 → perfNoPublish
      perf('EXT-999', '2026-01-05', { gmvAmount: 666, productTitle: '池外挂车品' }),
    ]);
    const report = await buildProductAttribution({ repo });

    expect(report.products).toHaveLength(0);
    expect(report.issues.noPerfData).toEqual([{ externalId: 'A', contentCount: 2 }]);
    expect(report.issues.outOfWindow).toEqual([{ externalId: 'B', statDays: 1 }]);
    expect(report.issues.perfNoPublish).toEqual([{ productId: 'EXT-999', productTitle: '池外挂车品', gmvAmount: 666 }]);
  });

  it('小样本护栏：单内容品照样展示但 sampleSufficient=false（不参与排名语义）', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    await selectProducts({ repo, date: DATE, externalIds: ['A'] });
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: PUBLISHED_AT });
    await repo.upsertProductStats([perf('A', DATE, { clickCnt: 100, orderCnt: 3, gmvAmount: 119.7 })]);

    const report = await buildProductAttribution({ repo });
    expect(report.products).toHaveLength(1);
    expect(report.products[0]!.sampleSufficient).toBe(false);
    expect(report.products[0]!.contentCount).toBe(1);
  });

  it('金额累加回两位小数（对账口径不丢分）', async () => {
    const repo = await publishedRepo();
    await repo.upsertProductStats([
      perf('A', '2026-01-05', { gmvAmount: 0.1, commissionAmount: 0.02 }),
      perf('A', '2026-01-06', { gmvAmount: 0.2, commissionAmount: 0.04 }),
    ]);
    const report = await buildProductAttribution({ repo });
    const a = report.products.find((p) => p.externalId === 'A')!;
    expect(a.totals.gmvAmount).toBe(0.3); // 0.1+0.2 浮点直加 = 0.30000000000000004，须规整
    expect(a.totals.commissionAmount).toBe(0.06);
  });

  it('days 非法（0 / 91 / 1.5 / NaN / Infinity）→ 拒绝', async () => {
    const repo = new MemoryRepo();
    for (const bad of [0, -1, 91, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(buildProductAttribution({ repo, days: bad })).rejects.toThrow(/1-90/);
    }
  });

  it('归因读取零写入：跑完报表后 repo 无任何新增（读侧报表红线）', async () => {
    const repo = await publishedRepo();
    await repo.upsertProductStats([perf('A', DATE, { clickCnt: 10, orderCnt: 1, gmvAmount: 39.9 })]);
    await repo.upsertSimStats([stat('manual', 'vx1', DATE, { playCnt: 50 })]);
    const before = await repo.getPublishRecords(DATE);
    await buildProductAttribution({ repo });
    const after = await repo.getPublishRecords(DATE);
    expect(after).toEqual(before); // 只读报表：不改任何行
  });

  it('空台账 → 空报表不炸（前提提示靠 issues 为空判断）', async () => {
    const repo = new MemoryRepo();
    const report = await buildProductAttribution({ repo });
    expect(report.products).toEqual([]);
    expect(report.issues.noPerfData).toEqual([]);
    expect(report.issues.outOfWindow).toEqual([]);
    expect(report.issues.perfNoPublish).toEqual([]);
  });
});
