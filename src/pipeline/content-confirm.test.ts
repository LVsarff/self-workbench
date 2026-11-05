import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot, XiaohongshuNote } from '../core/types.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import type { ContentDraftInput } from '../db/repo.js';
import { runDailyScan } from './daily-scan.js';
import { selectProducts } from './select.js';
import { runContentGen } from './content-gen.js';
import { confirmContentDraft, discardContentDraft, GATE3_CHECKLIST } from './content-confirm.js';

const DATE = '2026-01-05';
const ALL_TRUE = [true, true, true, true, true];

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

/** 已生成 4 条干净草稿的仓储（A、B 各双平台，全 draft） */
async function draftedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B', { competition: 1 })], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
  await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
  return repo;
}

/** 覆盖一条草稿行（构造门③ 的边界状态：banned 留痕 / 审查风险 / needs_manual 等） */
async function upsertDraft(
  repo: MemoryRepo,
  externalId: string,
  platform: 'xiaohongshu' | 'douyin',
  patch: Partial<ContentDraftInput>,
): Promise<void> {
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

function findDraft(drafts: Awaited<ReturnType<MemoryRepo['getContentDrafts']>>, externalId: string, platform: string) {
  return drafts.find((d) => d.externalId === externalId && d.platform === platform)!;
}

describe('confirmContentDraft：清单校验（先于一切查库）', () => {
  it('answers 数量不对 → 拒绝', async () => {
    const repo = await draftedRepo();
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: [true, true] }),
    ).rejects.toThrow(/逐项回答 5 项/);
  });

  it('清单任一项未确认 → 拒绝并列出该项', async () => {
    const repo = await draftedRepo();
    const answers = [true, true, false, true, true];
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers }),
    ).rejects.toThrow(/清单项未确认/);
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers }),
    ).rejects.toThrow('符合账号人设'); // 具体列出第 3 项
  });

  it('草稿不存在 → 拒绝', async () => {
    const repo = await draftedRepo();
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'C', platform: 'xiaohongshu', answers: ALL_TRUE }),
    ).rejects.toThrow(/没有找到/);
  });
});

describe('confirmContentDraft：状态与硬拦截', () => {
  it('needs_manual 草稿（内容为空）→ 拒绝确认', async () => {
    const repo = await draftedRepo();
    await upsertDraft(repo, 'A', 'xiaohongshu', { status: 'needs_manual', content: null, note: '词表命中未修复: 全网第一' });
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE }),
    ).rejects.toThrow(/内容为空/);
  });

  it('banned_hits 非空 → 硬拦截（纵深防御：正常流水线该状态早已转 needs_manual）', async () => {
    const repo = await draftedRepo();
    await upsertDraft(repo, 'A', 'xiaohongshu', { bannedHits: ['全网第一'] });
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE }),
    ).rejects.toThrow(/词表命中（硬拦截）/);

    const drafts = await repo.getContentDrafts(DATE);
    expect(findDraft(drafts, 'A', 'xiaohongshu').status).toBe('draft'); // 状态不被推进
    expect(await repo.getContentDecisions(DATE)).toHaveLength(0); // 不留决策
  });

  it('L2 审查提示（review.pass=false）不拦截 → 人工终判后可确认', async () => {
    const repo = await draftedRepo();
    await upsertDraft(repo, 'A', 'xiaohongshu', {
      review: { pass: false, risks: [{ type: 'exaggeration', detail: '"超出预期"略夸张' }], model: 'fixed-reviewer' },
    });
    const result = await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
    expect(result.platform).toBe('xiaohongshu');
    expect(findDraft(await repo.getContentDrafts(DATE), 'A', 'xiaohongshu').status).toBe('confirmed');
  });
});

describe('confirmContentDraft：确认与留痕', () => {
  it('5 项全确认 → 状态 confirmed + 决策 append-only 留痕（checklist 逐项）', async () => {
    const repo = await draftedRepo();
    const result = await confirmContentDraft({
      repo,
      date: DATE,
      externalId: 'A',
      platform: 'xiaohongshu',
      answers: ALL_TRUE,
      note: '复核过商品页',
    });

    expect(result.date).toBe(DATE);
    expect(result.externalId).toBe('A');
    const drafts = await repo.getContentDrafts(DATE);
    const aXhs = findDraft(drafts, 'A', 'xiaohongshu');
    expect(aXhs.status).toBe('confirmed');
    expect(findDraft(drafts, 'B', 'xiaohongshu').status).toBe('draft'); // 只推进这一条

    const decisions = await repo.getContentDecisions(DATE);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.action).toBe('confirmed');
    expect(d.platform).toBe('xiaohongshu');
    expect(d.draftId).toBe(aXhs.id);
    expect(d.runId).toBe(aXhs.runId);
    expect(d.batchDate).toBe(DATE);
    expect(d.decidedBy).toBe('human');
    expect(d.note).toBe('复核过商品页');
    expect(d.checklist).toHaveLength(GATE3_CHECKLIST.length);
    expect(d.checklist!.every((c, i) => c.item === GATE3_CHECKLIST[i] && c.pass === true)).toBe(true);
  });

  it('重复确认 → 幂等拦截，不产生第二条决策', async () => {
    const repo = await draftedRepo();
    await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE }),
    ).rejects.toThrow(/已确认过/);
    expect(await repo.getContentDecisions(DATE)).toHaveLength(1);
  });
});

describe('discardContentDraft：弃用', () => {
  it('弃用 → 状态 discarded + 决策留痕（checklist null）', async () => {
    const repo = await draftedRepo();
    await discardContentDraft({ repo, date: DATE, externalId: 'A', platform: 'douyin', note: '角度重复' });

    const drafts = await repo.getContentDrafts(DATE);
    expect(findDraft(drafts, 'A', 'douyin').status).toBe('discarded');
    expect(findDraft(drafts, 'A', 'xiaohongshu').status).toBe('draft'); // 另一平台不受影响
    const decisions = await repo.getContentDecisions(DATE);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe('discarded');
    expect(decisions[0]!.checklist).toBeNull();
    expect(decisions[0]!.note).toBe('角度重复');
  });

  it('重复弃用 → 幂等拦截；已弃用的不能确认', async () => {
    const repo = await draftedRepo();
    await discardContentDraft({ repo, date: DATE, externalId: 'A', platform: 'douyin' });
    await expect(discardContentDraft({ repo, date: DATE, externalId: 'A', platform: 'douyin' })).rejects.toThrow(/已废弃/);
    await expect(
      confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'douyin', answers: ALL_TRUE }),
    ).rejects.toThrow(/已废弃/);
    expect(await repo.getContentDecisions(DATE)).toHaveLength(1);
  });

  it('草稿不存在 → 拒绝', async () => {
    const repo = await draftedRepo();
    await expect(discardContentDraft({ repo, date: DATE, externalId: 'B', platform: 'xiaohongshu' })).resolves.toBeDefined();
    await expect(discardContentDraft({ repo, date: DATE, externalId: 'C', platform: 'xiaohongshu' })).rejects.toThrow(/没有找到/);
  });
});
