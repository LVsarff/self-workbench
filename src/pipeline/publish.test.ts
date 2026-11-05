/**
 * 发布台账（模块③ B2）测试：时段表 / 同步入队 / 队列视图 / 回填幂等 / 端到端。
 * 关键语义：
 *   - plannedAt 落库必须是真 ISO（防 timestamptz 按连接时区误解析）
 *   - list 防御过滤：草稿当前非 confirmed 的存量 pending 不展示（防误发布已弃用内容）
 *   - record 幂等拒绝：一条记录只回填一次
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { Platform, ProductSnapshot } from '../core/types.js';
import { nextPublishSlot, shanghaiSlotToIso, isoToShanghaiDisplay, suggestSlots } from '../core/publish-slots.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import type { ContentDraftInput } from '../db/repo.js';
import { runDailyScan } from './daily-scan.js';
import { selectProducts } from './select.js';
import { runContentGen } from './content-gen.js';
import { confirmContentDraft, discardContentDraft } from './content-confirm.js';
import { listPublishQueue, PUBLISH_OVERDUE_MS, recordPublish, syncPublishQueue } from './publish.js';

const DATE = '2026-01-05';
const ALL_TRUE = [true, true, true, true, true];
/** 上海 '2026-01-05 10:00' */
const NOW_10 = new Date('2026-01-05T02:00:00Z');

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

/** 已生成 4 条草稿（A、B 各双平台，全 draft）的仓储 */
async function draftedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B', { competition: 1 })], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
  await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
  return repo;
}

/** 确认 A/xhs + B/douyin 后的仓储（两条 confirmed，两条 draft） */
async function confirmedRepo(): Promise<MemoryRepo> {
  const repo = await draftedRepo();
  await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
  await confirmContentDraft({ repo, date: DATE, externalId: 'B', platform: 'douyin', answers: ALL_TRUE });
  return repo;
}

/** 覆盖一条草稿行（构造非 confirmed 边界状态） */
async function upsertDraft(repo: MemoryRepo, externalId: string, platform: Platform, patch: Partial<ContentDraftInput>): Promise<void> {
  const list = (await repo.getDailyList(DATE))!;
  const item = list.items.find((i) => i.externalId === externalId)!;
  await repo.saveContentDrafts([
    {
      runId: list.runId,
      batchDate: DATE,
      productId: item.productId,
      platform,
      status: 'draft',
      content: { title: '测试标题五个字', body: 'x'.repeat(160), tags: ['好物', '开箱', '实测'], coverIdea: null },
      bannedHits: [],
      review: null,
      duplicates: [],
      revisionCount: 0,
      note: null,
      source: 'llm',
      ...patch,
    },
  ]);
}

describe('publish-slots：时段静态表（纯代码零 LLM）', () => {
  it('10:00 → 今日 12:00（小红书第一档）', () => {
    expect(nextPublishSlot('xiaohongshu', NOW_10)).toBe('2026-01-05 12:00');
  });

  it('11:40 → 30 分钟缓冲不足 12:00，跳到 18:00', () => {
    expect(nextPublishSlot('xiaohongshu', new Date('2026-01-05T03:40:00Z'))).toBe('2026-01-05 18:00');
  });

  it('23:00 → 今日档全过，滚动到明日第一档（日期进位交给 Date）', () => {
    expect(nextPublishSlot('xiaohongshu', new Date('2026-01-05T15:00:00Z'))).toBe('2026-01-06 12:00');
  });

  it('suggestSlots：10:00 → 今日全部 3 档', () => {
    expect(suggestSlots('xiaohongshu', NOW_10)).toEqual(['2026-01-05 12:00', '2026-01-05 18:00', '2026-01-05 21:00']);
  });

  it('suggestSlots：20:45 小红书 21:00 不可选 → 明日 3 档', () => {
    expect(suggestSlots('xiaohongshu', new Date('2026-01-05T12:45:00Z'))).toEqual([
      '2026-01-06 12:00',
      '2026-01-06 18:00',
      '2026-01-06 21:00',
    ]);
  });

  it('suggestSlots：21:00 抖音 22:00 仍可选 → 仅 1 档', () => {
    expect(suggestSlots('douyin', new Date('2026-01-05T13:00:00Z'))).toEqual(['2026-01-05 22:00']);
  });

  it('shanghaiSlotToIso ↔ isoToShanghaiDisplay 往返一致（上海时间 21:00 = UTC 13:00）', () => {
    const iso = shanghaiSlotToIso('2026-01-05 21:00');
    expect(iso).toBe('2026-01-05T13:00:00.000Z');
    expect(isoToShanghaiDisplay(iso)).toBe('2026-01-05 21:00');
  });
});

describe('syncPublishQueue：已确认 → 待发布（幂等）', () => {
  it('只有 confirmed 入队；plannedAt 落库为真 ISO（上海 10:00 → 12:00 档）', async () => {
    const repo = await confirmedRepo();
    const result = await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(result).toEqual({ date: DATE, created: 2, skipped: 0 });

    const records = await repo.getPublishRecords(DATE);
    expect(records).toHaveLength(2);
    const aXhs = records.find((r) => r.platform === 'xiaohongshu')!;
    expect(aXhs.status).toBe('pending');
    expect(aXhs.plannedAt).toBe('2026-01-05T04:00:00.000Z'); // 上海 12:00 的 ISO，非本地时间字面量
    expect(aXhs.url).toBeNull();
  });

  it('重跑幂等：created=0 skipped=2，不产生重复记录', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    const again = await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(again).toEqual({ date: DATE, created: 0, skipped: 2 });
    expect(await repo.getPublishRecords(DATE)).toHaveLength(2);
  });

  it('没有 confirmed（全 draft）→ 什么都不入队', async () => {
    const repo = await draftedRepo();
    const result = await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(result).toEqual({ date: DATE, created: 0, skipped: 0 });
  });

  it("needs_manual / discarded 同样不入队（以 status='confirmed' 为唯一口径）", async () => {
    const repo = await draftedRepo();
    await upsertDraft(repo, 'A', 'xiaohongshu', { status: 'needs_manual', content: null, note: '人工撰写' });
    await upsertDraft(repo, 'A', 'douyin', { status: 'discarded' });
    const result = await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(result.created).toBe(0);
  });
});

describe('listPublishQueue：队列视图与防御过滤', () => {
  it('展示 pending + suggestedSlots；注入 now 判定 overdue（24h 阈值）', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });

    const fresh = await listPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(fresh).toHaveLength(2);
    expect(fresh.every((i) => i.overdue)).toBe(false);
    expect(fresh.every((i) => i.suggestedSlots.length > 0)).toBe(true);

    // 入队后 25h 再看 → 全部超时提醒
    const createdAt = new Date(fresh[0]!.record.createdAt).getTime();
    const later = await listPublishQueue({ repo, date: DATE, now: new Date(createdAt + PUBLISH_OVERDUE_MS + 60_000) });
    expect(later.every((i) => i.overdue)).toBe(true);
  });

  it('确认后弃用 → 存量 pending 不展示、不可回填（防误发布已废弃内容）', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await discardContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', note: '事后发现卖点过时' });

    const items = await listPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(items).toHaveLength(1);
    expect(items[0]!.draft.externalId).toBe('B');

    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a' }),
    ).rejects.toThrow(/仅门③ 已确认内容可回填/);
  });

  it('已发布在前、待发布在后排序；pending 优先展示', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'B', platform: 'douyin', url: 'https://v.douyin.com/b', now: NOW_10 });

    const items = await listPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(items.map((i) => i.record.status)).toEqual(['pending', 'published']);
  });
});

describe('recordPublish：人工回填（门④）', () => {
  it('正常回填：url/时间/AI 标注落库，默认未标注', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    const result = await recordPublish({
      repo,
      date: DATE,
      externalId: 'A',
      platform: 'xiaohongshu',
      url: '  https://www.xiaohongshu.com/explore/abc123  ', // 前后空白被 trim
      now: new Date('2026-01-05T13:00:00Z'),
    });
    expect(result.record.url).toBe('https://www.xiaohongshu.com/explore/abc123');
    expect(result.record.publishedAt).toBe('2026-01-05T13:00:00.000Z');
    expect(result.record.aiLabeled).toBe(false);
    expect(result.record.status).toBe('published');

    // 台账里持久化为 published
    const persisted = (await repo.getPublishRecords(DATE)).find((r) => r.platform === 'xiaohongshu')!;
    expect(persisted.status).toBe('published');
    expect(persisted.url).toBe('https://www.xiaohongshu.com/explore/abc123');
  });

  it('--at 显式时间（ISO 带时区）→ 正确解析', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    const result = await recordPublish({
      repo,
      date: DATE,
      externalId: 'A',
      platform: 'xiaohongshu',
      url: 'https://xhs.link/a',
      publishedAt: '2026-01-05T21:00:00+08:00',
    });
    expect(result.record.publishedAt).toBe('2026-01-05T13:00:00.000Z');
  });

  it('重复回填 → 幂等拒绝（一条记录只回填一次）', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a' });
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a2' }),
    ).rejects.toThrow(/已回填过/);
  });

  it('草稿不存在 → 拒绝；草稿存在但未确认 → 状态错误（提示优先级：状态先于平台提示）', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'C', platform: 'xiaohongshu', url: 'https://xhs.link/c' }),
    ).rejects.toThrow(/没有找到 C/);
    // A/douyin 草稿存在但为 draft → 报状态而非平台提示
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'douyin', url: 'https://v.douyin.com/a' }),
    ).rejects.toThrow(/仅门③ 已确认内容可回填/);
  });

  it('未确认（draft）→ 拒绝回填', async () => {
    const repo = await draftedRepo();
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a' }),
    ).rejects.toThrow(/仅门③ 已确认内容可回填/);
  });

  it('已确认但没有队列记录 → 提示先 publish-sync', async () => {
    const repo = await confirmedRepo();
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a' }),
    ).rejects.toThrow(/先执行 gwd publish-sync/);
  });

  it('url 校验：空白 / 超 500 字符均拒绝', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await expect(recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: '   ' })).rejects.toThrow(
      /链接不能为空/,
    );
    await expect(recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'x'.repeat(501) })).rejects.toThrow(
      /链接过长（501 字符/,
    );
  });

  it('--at 非法格式 → 拒绝', async () => {
    const repo = await confirmedRepo();
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', publishedAt: 'not-a-date' }),
    ).rejects.toThrow(/发布时间格式无效/);
  });
});

describe('端到端：门③ 确认 → 队列 → 人工发布 → 台账（V3 归因事实表）', () => {
  it('内容↔品↔平台↔时间全绑定', async () => {
    const repo = await confirmedRepo();
    await confirmContentDraft({ repo, date: DATE, externalId: 'B', platform: 'xiaohongshu', answers: ALL_TRUE });
    const sync = await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    expect(sync.created).toBe(3); // A/xhs + B/douyin + B/xhs

    const rec = await recordPublish({
      repo,
      date: DATE,
      externalId: 'B',
      platform: 'xiaohongshu',
      url: 'https://www.xiaohongshu.com/explore/b1',
      aiLabeled: true,
    });

    // 事实表字段完整可归因
    const drafts = await repo.getContentDrafts(DATE);
    const bXhs = drafts.find((d) => d.externalId === 'B' && d.platform === 'xiaohongshu')!;
    expect(rec.record.draftId).toBe(bXhs.id);
    expect(rec.record.platform).toBe('xiaohongshu');
    expect(rec.record.publishedAt).not.toBeNull();
    expect(rec.record.aiLabeled).toBe(true);

    // 队列视图：1 published + 2 pending
    const items = await listPublishQueue({ repo, date: DATE, now: NOW_10 });
    const published = items.filter((i) => i.record.status === 'published');
    expect(published).toHaveLength(1);
    expect(published[0]!.draft.externalId).toBe('B');
  });
});
