/**
 * 内容层表现归因（模块⑤ V3 框架先行）测试。
 * 关键语义：
 *   - join 锚点：publish_records.video_id ↔ sim_stats(source='manual').video_id
 *   - 窗口过滤：发布日（上海时区）+ N-1 天，窗外行不计入
 *   - 双源隔离红线：kuairec 同 video_id 撞号永不参与归因
 *   - 不猜：播放 0 → 完播率/互动率 null（不是 0%）
 *   - 小样本护栏：品级 <2 条已归因内容 → sampleSufficient=false
 *   - 未归因清单：noVideoId / noStats / outOfWindow 逐条给原因，不静默跳过
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import type { SimContentStatRow, SimSource } from '../db/repo.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { runDailyScan } from './daily-scan.js';
import { selectProducts } from './select.js';
import { runContentGen } from './content-gen.js';
import { confirmContentDraft } from './content-confirm.js';
import { recordPublish, syncPublishQueue } from './publish.js';
import { buildAttribution, linkVideoId, DEFAULT_ATTRIBUTION_DAYS } from './attribution.js';

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

/** 「账号-内容-日」表现行（source 可选：manual=真实 / kuairec=模拟，红线按 source 隔离） */
function stat(source: SimSource, videoId: string, statDate: string, o: Partial<SimContentStatRow> = {}): SimContentStatRow {
  return {
    source,
    videoId,
    authorId: 'me',
    statDate,
    videoType: null,
    uploadDt: null,
    videoDuration: null,
    videoTagName: null,
    showCnt: 0,
    playCnt: 0,
    completePlayCnt: 0,
    likeCnt: 0,
    commentCnt: 0,
    shareCnt: 0,
    followCnt: 0,
    collectCnt: 0,
    reportCnt: 0,
    caption: null,
    topicTag: null,
    category: null,
    ...o,
  };
}

/** 四条记录全部发布（A/xhs=vx1 · A/douyin=vx2 · B/xhs=v-old · B/douyin=v-empty） */
async function publishedRepo(): Promise<MemoryRepo> {
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
  await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: PUBLISHED_AT, videoId: 'vx1' });
  await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'douyin', url: 'https://v.douyin.com/a', publishedAt: PUBLISHED_AT, videoId: 'vx2' });
  await recordPublish({ repo, date: DATE, externalId: 'B', platform: 'xiaohongshu', url: 'https://xhs.link/b', publishedAt: PUBLISHED_AT, videoId: 'v-old' });
  await recordPublish({ repo, date: DATE, externalId: 'B', platform: 'douyin', url: 'https://v.douyin.com/b', publishedAt: PUBLISHED_AT, videoId: 'v-empty' });
  return repo;
}

/** 表现数据：vx1/vx2 窗口内有数据；v-old 只有窗外数据；v-empty 无数据；kuairec 撞号永不参与 */
async function seedStats(repo: MemoryRepo): Promise<void> {
  await repo.upsertSimStats([
    // vx1：窗口内 2 天（01-05 / 01-06）+ 窗外各 1 天（01-04 早于发布 / 01-12 晚于窗口）
    stat('manual', 'vx1', '2026-01-05', { showCnt: 1000, playCnt: 100, completePlayCnt: 50, likeCnt: 10, commentCnt: 2, shareCnt: 1, collectCnt: 3, followCnt: 5 }),
    stat('manual', 'vx1', '2026-01-06', { showCnt: 500, playCnt: 50, completePlayCnt: 20, likeCnt: 5, commentCnt: 1, shareCnt: 0, collectCnt: 1, followCnt: 2 }),
    stat('manual', 'vx1', '2026-01-04', { playCnt: 777 }),
    stat('manual', 'vx1', '2026-01-12', { playCnt: 999 }),
    // vx2：窗口内 1 天，播放 0（除零护栏：率值 → null 不是 0%）
    stat('manual', 'vx2', '2026-01-05', { showCnt: 200, playCnt: 0 }),
    // v-old：只有窗口外数据（发布日之前——发布时间回填错误的典型形态）
    stat('manual', 'v-old', '2026-01-01', { playCnt: 42 }),
    // 红线：kuairec 模拟数据同 video_id 撞号，数据再大也不进归因
    stat('kuairec', 'vx1', '2026-01-05', { playCnt: 1_000_000 }),
  ]);
}

describe('recordPublish：--video-id 归因锚点回填', () => {
  it('回填时带上 videoId → 落库持久化', async () => {
    const repo = await publishedRepo();
    const rows = await repo.listPublishedForAttribution();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.record.videoId != null)).toBe(true);
    expect(rows.find((r) => r.externalId === 'A' && r.record.platform === 'xiaohongshu')!.record.videoId).toBe('vx1');
  });

  it('回填时缺省 videoId → null（可 attribution-link 后补）', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    await selectProducts({ repo, date: DATE, externalIds: ['A'] });
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: PUBLISHED_AT });
    const rows = await repo.listPublishedForAttribution();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.record.videoId).toBeNull();
    expect(rows[0]!.externalId).toBe('A');
    expect(rows[0]!.title).toBe('商品A');
  });
});

describe('buildAttribution：join / 窗口 / 汇总（零 LLM）', () => {
  it('窗口内 join 累计 + 率值口径 + 窗外行不计入 + kuairec 撞号隔离', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo });

    expect(report.days).toBe(DEFAULT_ATTRIBUTION_DAYS);
    expect(report.disclaimer).toContain('真实通道');
    expect(report.disclaimer).toContain('无成交归因');

    const vx1 = report.contents.find((c) => c.videoId === 'vx1')!;
    expect(vx1.externalId).toBe('A');
    expect(vx1.platform).toBe('xiaohongshu');
    expect(vx1.windowFrom).toBe('2026-01-05');
    expect(vx1.windowTo).toBe('2026-01-11');
    expect(vx1.statDays).toBe(2); // 01-04 / 01-12 两行窗外行不计入
    expect(vx1.totals.playCnt).toBe(150); // 100 + 50（kuairec 的 100 万不计入）
    expect(vx1.totals.showCnt).toBe(1500);
    expect(vx1.totals.completePlayCnt).toBe(70);
    expect(vx1.totals.likeCnt).toBe(15);
    expect(vx1.totals.followCnt).toBe(7);
    expect(vx1.completeRate).toBeCloseTo(70 / 150);
    expect(vx1.interactionRate).toBeCloseTo((15 + 3 + 1 + 4) / 150);
  });

  it('播放 0 → 完播率/互动率 null（不猜，不是 0%）', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo });
    const vx2 = report.contents.find((c) => c.videoId === 'vx2')!;
    expect(vx2.totals.playCnt).toBe(0);
    expect(vx2.totals.showCnt).toBe(200);
    expect(vx2.completeRate).toBeNull();
    expect(vx2.interactionRate).toBeNull();
  });

  it('内容排序：窗口播放降序（vx1 150 > vx2 0）', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo });
    expect(report.contents.map((c) => c.videoId)).toEqual(['vx1', 'vx2']);
  });

  it('品级汇总：比率 = 分子和各自求和（非平均）；样本充足判定；未归因品照样列出', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo });

    const a = report.products.find((p) => p.externalId === 'A')!;
    expect(a.attributedCount).toBe(2); // vx1 + vx2
    expect(a.contentCount).toBe(2);
    expect(a.sampleSufficient).toBe(true);
    expect(a.totals.playCnt).toBe(150);
    expect(a.platforms).toEqual(['xiaohongshu', 'douyin']);
    expect(a.completeRate).toBeCloseTo(70 / 150); // 0/0 品不贡献分母偏差

    const b = report.products.find((p) => p.externalId === 'B')!;
    expect(b.attributedCount).toBe(0); // v-old 窗外 / v-empty 无数据
    expect(b.contentCount).toBe(2);
    expect(b.sampleSufficient).toBe(false);
    expect(b.totals.playCnt).toBe(0);

    expect(report.products.map((p) => p.externalId)).toEqual(['A', 'B']); // 播放降序
  });

  it('平台汇总：双平台各自计数', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo });
    const xhs = report.platforms.find((p) => p.platform === 'xiaohongshu')!;
    const douyin = report.platforms.find((p) => p.platform === 'douyin')!;
    expect(xhs.attributedCount).toBe(1); // vx1
    expect(douyin.attributedCount).toBe(1); // vx2
    expect(xhs.totals.playCnt).toBe(150);
    expect(douyin.totals.playCnt).toBe(0);
  });

  it('未归因清单：noVideoId / noStats / outOfWindow 逐条给原因（不静默跳过）', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo });
    expect(report.issues.noStats).toEqual([{ externalId: 'B', platform: 'douyin', videoId: 'v-empty' }]);
    expect(report.issues.outOfWindow).toEqual([{ externalId: 'B', platform: 'xiaohongshu', videoId: 'v-old', statDays: 1 }]);
    expect(report.issues.noVideoId).toEqual([]);
  });

  it('noVideoId：已发布未回填 video_id → 计入 issue 且不进 contents', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    await selectProducts({ repo, date: DATE, externalIds: ['A'] });
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: PUBLISHED_AT });

    const report = await buildAttribution({ repo });
    expect(report.contents).toHaveLength(0);
    expect(report.issues.noVideoId).toEqual([{ externalId: 'A', platform: 'xiaohongshu', publishedAt: PUBLISHED_AT }]);
  });

  it('空台账 → 空报表不炸（前提提示）', async () => {
    const repo = new MemoryRepo();
    const report = await buildAttribution({ repo });
    expect(report.contents).toEqual([]);
    expect(report.products).toEqual([]);
    expect(report.platforms).toEqual([]);
    expect(report.issues.noVideoId).toEqual([]);
  });

  it('platform 过滤：只看单平台，contentCount 同口径收窄', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo, platform: 'xiaohongshu' });
    expect(report.contents.map((c) => c.videoId)).toEqual(['vx1']);
    const a = report.products.find((p) => p.externalId === 'A')!;
    expect(a.contentCount).toBe(1); // 只数 xhs 的已发布记录
    expect(a.attributedCount).toBe(1);
    expect(report.platforms.every((p) => p.platform === 'xiaohongshu')).toBe(true);
  });

  it('days=1：窗口收窄到发布当日', async () => {
    const repo = await publishedRepo();
    await seedStats(repo);
    const report = await buildAttribution({ repo, days: 1 });
    const vx1 = report.contents.find((c) => c.videoId === 'vx1')!;
    expect(vx1.windowTo).toBe('2026-01-05');
    expect(vx1.statDays).toBe(1);
    expect(vx1.totals.playCnt).toBe(100);
  });

  it('days 非法（0 / 91 / 1.5 / NaN）→ 拒绝', async () => {
    const repo = new MemoryRepo();
    await expect(buildAttribution({ repo, days: 0 })).rejects.toThrow(/1-90/);
    await expect(buildAttribution({ repo, days: 91 })).rejects.toThrow(/1-90/);
    await expect(buildAttribution({ repo, days: 1.5 })).rejects.toThrow(/1-90/);
    await expect(buildAttribution({ repo, days: Number.NaN })).rejects.toThrow(/1-90/);
  });
});

describe('linkVideoId：发布后补链（幂等可重跑）', () => {
  async function linkedRepo(): Promise<MemoryRepo> {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    await selectProducts({ repo, date: DATE, externalIds: ['A'] });
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: PUBLISHED_AT });
    return repo;
  }

  it('补链 → 归因立即生效（noVideoId issue 清空）', async () => {
    const repo = await linkedRepo();
    await repo.upsertSimStats([stat('manual', 'vx9', '2026-01-05', { playCnt: 30 })]);

    const before = await buildAttribution({ repo });
    expect(before.issues.noVideoId).toHaveLength(1);

    const linked = await linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', videoId: ' vx9 ' });
    expect(linked.videoId).toBe('vx9'); // trim 规整

    const after = await buildAttribution({ repo });
    expect(after.issues.noVideoId).toEqual([]);
    expect(after.contents).toHaveLength(1);
    expect(after.contents[0]!.videoId).toBe('vx9');
    expect(after.contents[0]!.totals.playCnt).toBe(30);
  });

  it('重复补链同值 → 幂等（不抛错不产生副作用）', async () => {
    const repo = await linkedRepo();
    await linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', videoId: 'vx9' });
    await linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', videoId: 'vx9' });
    const rows = await repo.listPublishedForAttribution();
    expect(rows[0]!.record.videoId).toBe('vx9');
  });

  it('pending（尚未发布回填）→ 拒绝补链（video_id 发布后才能拿到）', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A'), snap('B')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    await confirmContentDraft({ repo, date: DATE, externalId: 'B', platform: 'douyin', answers: ALL_TRUE });
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 }); // B/douyin pending
    await expect(
      linkVideoId({ repo, date: DATE, externalId: 'B', platform: 'douyin', videoId: 'vx9' }),
    ).rejects.toThrow(/尚未回填发布/);
  });

  it('草稿不存在 / 无发布记录 → 明确报错', async () => {
    const repo = await linkedRepo();
    await expect(linkVideoId({ repo, date: DATE, externalId: 'C', platform: 'xiaohongshu', videoId: 'vx9' })).rejects.toThrow(/没有找到 C/);
    // A/douyin 草稿存在但从未入队
    await expect(linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'douyin', videoId: 'vx9' })).rejects.toThrow(/没有发布记录/);
  });

  it('videoId 非法载荷 → 入口拒绝', async () => {
    const repo = await linkedRepo();
    await expect(linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', videoId: '  ' })).rejects.toThrow(/不能为空/);
    await expect(linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', videoId: "1' OR '1'='1" })).rejects.toThrow(/非法字符/);
  });
});
