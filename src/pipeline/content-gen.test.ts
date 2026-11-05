import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ContentRisk, DouyinScript, ProductSnapshot, XiaohongshuNote } from '../core/types.js';
import {
  createScriptedContentAgent,
  type ContentAgent,
  type ContentAgentResult,
  type ContentRequest,
} from '../agent/content-agent.js';
import type { ContentReviewer, ContentReviewResult } from '../agent/content-reviewer.js';
import { runDailyScan } from './daily-scan.js';
import { selectProducts } from './select.js';
import { runContentGen } from './content-gen.js';

const DATE = '2026-01-05';
/** 历史窗口夹具日期（在 [date-14d, date) 窗口内） */
const HISTORY_DATE = '2026-01-04';

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

/** 已跑完 daily-scan 并勾选 A、B 的仓储（C 留作历史窗口种子） */
async function selectedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B', { competition: 1 }), snap('C', { commissionRate: 10 })], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
  return repo;
}

/**
 * 确定性伪随机文本（仅 0-9a-z）：跨品字符序列不相关（bigram 交集≈随机碰撞水平）。
 * 注意不能用品简单的线性迭代——乘子链 mod 36 会退化成等差序列，不同种子只差一个循环移位，
 * bigram 集合完全相同（实测相似度 0.9+，去重层会全部误报）。此处用 FNV-1a 播种 + xorshift32 展开。
 */
function hashText(seed: string, length: number): string {
  let h = 2166136261;
  for (let j = 0; j < seed.length; j += 1) h = Math.imul(h ^ seed.charCodeAt(j), 16777619) >>> 0;
  let x = h || 1;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += (x % 36).toString(36);
  }
  return out;
}

/** 干净正文（160 字，无极限词） */
function cleanBody(externalId: string): string {
  return hashText(`c:${externalId}`, 160);
}

/** 含极限词正文（命中词表 '全网第一'，160 字） */
function bannedBody(externalId: string): string {
  return `${hashText(`b:${externalId}`, 150)}全网第一，全网第一，`;
}

/** 固定产出的 Agent（可注入正文 / 修订正文 / 缺平台 / 抛异常 / 捕获请求） */
function fixedAgent(overrides: {
  body?: (externalId: string) => string;
  /** 修订模式下使用的正文（未提供则沿用 body） */
  revisionBody?: (externalId: string) => string;
  omitDouyin?: boolean;
  throwErr?: boolean;
  capture?: ContentRequest[];
} = {}): ContentAgent {
  return {
    name: 'fixed',
    async generate(req): Promise<ContentAgentResult> {
      overrides.capture?.push(req);
      if (overrides.throwErr) throw new Error('boom');
      const inRevision = (req.revision?.length ?? 0) > 0;
      const bodyFor = (inRevision ? (overrides.revisionBody ?? overrides.body) : overrides.body) ?? cleanBody;
      const body = bodyFor(req.product.externalId);
      const pad = hashText(`dy:${req.product.externalId}`, 16); // 跨品错开（抖音骨架句共享 bigram 多）
      const result: ContentAgentResult = {
        xiaohongshu: {
          title: '测试标题五个字',
          body,
          tags: ['好物', '开箱', '实测'],
          coverIdea: null,
        },
        douyin: overrides.omitDouyin
          ? null
          : {
              hook: '这个真的可以冲',
              points: [`【${pad}】${req.product.externalId}号价格挺实惠`, '实测真的好用的'],
              cta: '链接在评论区',
            },
        submitted: true,
        degraded: false,
        audit: {
          purpose: 'content-gen:drafts',
          model: 'fixed',
          skill: 'test',
          input: { prompt: `${inRevision ? 'revision' : 'product'}: ${req.product.externalId}` },
          output: { revision: inRevision },
        },
      };
      return result;
    },
  };
}

/** 固定结论的审查器（可注入风险 / 抛异常） */
function fixedReviewer(overrides: { risks?: ContentRisk[]; throwErr?: boolean } = {}): ContentReviewer {
  return {
    name: 'fixed-reviewer',
    async review(): Promise<ContentReviewResult> {
      if (overrides.throwErr) throw new Error('review boom');
      const risks = overrides.risks ?? [];
      return { pass: risks.length === 0, risks };
    },
  };
}

/** 直接落一条历史草稿（绕过流水线，用于历史窗口夹具） */
async function seedHistoryDraft(
  repo: MemoryRepo,
  externalId: string,
  platform: 'xiaohongshu' | 'douyin',
  content: XiaohongshuNote | DouyinScript,
  status: 'draft' | 'confirmed' = 'draft',
): Promise<void> {
  const list = (await repo.getDailyList(DATE))!;
  const item = list.items.find((i) => i.externalId === externalId)!;
  await repo.saveContentDrafts([
    {
      runId: list.runId,
      batchDate: HISTORY_DATE,
      productId: item.productId,
      platform,
      status,
      content,
      bannedHits: [],
      review: null,
      duplicates: [],
      revisionCount: 0,
      note: null,
      source: 'llm',
    },
  ]);
}

describe('runContentGen：前置校验', () => {
  it('没有清单 → 报错', async () => {
    const repo = new MemoryRepo();
    await expect(runContentGen({ repo, date: DATE, agent: fixedAgent() })).rejects.toThrow(/没有候选清单/);
  });

  it('没有勾选 → 报错', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    await expect(runContentGen({ repo, date: DATE, agent: fixedAgent() })).rejects.toThrow(/没有勾选/);
  });
});

describe('runContentGen：生成与落库', () => {
  it('勾选品各生成小红书 + 抖音双版草稿（draft、llm 来源、零修订零重复）', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });

    expect(result.productCount).toBe(2);
    expect(result.generated).toBe(4); // 2 品 × 2 平台
    expect(result.needsManual).toBe(0);
    expect(result.degraded).toBe(false);
    expect(result.revisions).toBe(0);
    expect(result.reviewed).toBe(0); // 未配置审查器
    expect(result.bannedHitCount).toBe(0);
    expect(result.duplicateHitCount).toBe(0);

    const drafts = await repo.getContentDrafts(DATE);
    expect(drafts).toHaveLength(4);
    const xhs = drafts.find((d) => d.platform === 'xiaohongshu')!;
    expect(xhs.status).toBe('draft');
    expect(xhs.source).toBe('llm');
    expect(xhs.runId).toBe(result.runId);
    expect(xhs.review).toBeNull();
    expect(xhs.duplicates).toEqual([]);
    expect(xhs.revisionCount).toBe(0);
    expect(xhs.note).toBeNull();
    const note = xhs.content as XiaohongshuNote;
    expect(note.title.length).toBeGreaterThanOrEqual(5);
    expect(note.body.length).toBeGreaterThanOrEqual(150);
    const dy = drafts.find((d) => d.platform === 'douyin')!;
    expect((dy.content as DouyinScript).points.length).toBeGreaterThanOrEqual(2);
  });

  it('幂等：重跑跳过已生成的草稿', async () => {
    const repo = await selectedRepo();
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    const again = await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });

    expect(again.generated).toBe(0);
    expect(again.skipped).toBe(4);
    expect(await repo.getContentDrafts(DATE)).toHaveLength(4); // 不产生重复
  });

  it('--force 重新生成 draft 草稿', async () => {
    const repo = await selectedRepo();
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    const forced = await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent(), force: true });

    expect(forced.generated).toBe(4);
    expect(await repo.getContentDrafts(DATE)).toHaveLength(4); // 覆盖不新增
  });
});

describe('runContentGen：生成-自检-修订循环（L1）', () => {
  it('词表命中 → 修订修复（预算内修掉 → draft 干净落库）', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({
      repo,
      date: DATE,
      agent: fixedAgent({ body: bannedBody, revisionBody: cleanBody }),
    });

    expect(result.revisions).toBe(2); // 每品 1 轮
    expect(result.bannedHitCount).toBe(0);
    expect(result.generated).toBe(4);
    expect(result.needsManual).toBe(0);

    const drafts = await repo.getContentDrafts(DATE);
    for (const ext of ['A', 'B']) {
      const xhs = drafts.find((d) => d.externalId === ext && d.platform === 'xiaohongshu')!;
      expect(xhs.status).toBe('draft');
      expect(xhs.bannedHits).toEqual([]);
      expect(xhs.revisionCount).toBe(1);
      expect((xhs.content as XiaohongshuNote).body).toBe(cleanBody(ext)); // 用的是修订后的版本
      expect(xhs.note).toBeNull();
    }
    const dy = drafts.find((d) => d.platform === 'douyin')!;
    expect(dy.status).toBe('draft');
    expect(dy.revisionCount).toBe(0); // 合格平台不消耗修订预算
  });

  it('词表命中修不掉（预算耗尽）→ needs_manual + banned_hits 留痕（硬语义）', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: fixedAgent({ body: bannedBody }) });

    expect(result.generated).toBe(2); // 抖音双品正常
    expect(result.needsManual).toBe(2); // 小红书双品转人工
    expect(result.revisions).toBe(4); // 每品 2 轮
    expect(result.bannedHitCount).toBe(2);

    const drafts = await repo.getContentDrafts(DATE);
    for (const ext of ['A', 'B']) {
      const xhs = drafts.find((d) => d.externalId === ext && d.platform === 'xiaohongshu')!;
      expect(xhs.status).toBe('needs_manual');
      expect(xhs.content).toBeNull();
      expect(xhs.bannedHits).toEqual(['全网第一']);
      expect(xhs.revisionCount).toBe(2);
      expect(xhs.note).toContain('词表命中未修复');
      expect(xhs.note).toContain('已修订 2 轮');
    }
    const dy = drafts.find((d) => d.platform === 'douyin')!;
    expect(dy.status).toBe('draft'); // 合格平台不受牵连
    expect(dy.revisionCount).toBe(0);
  });

  it('与历史草稿高度相似 → 触发修订；修不掉仍是 draft + duplicates 留痕（提示层，门③ 终判）', async () => {
    const repo = await selectedRepo();
    // C 的历史草稿与 A 的产出完全一致 → 相似度 1.0
    await seedHistoryDraft(repo, 'C', 'xiaohongshu', {
      title: '测试标题五个字',
      body: cleanBody('A'),
      tags: ['好物', '开箱', '实测'],
      coverIdea: null,
    });
    const result = await runContentGen({ repo, date: DATE, agent: fixedAgent() });

    const drafts = await repo.getContentDrafts(DATE);
    const aXhs = drafts.find((d) => d.externalId === 'A' && d.platform === 'xiaohongshu')!;
    expect(aXhs.status).toBe('draft'); // 去重不阻塞（区别于词表硬语义）
    expect(aXhs.revisionCount).toBe(2); // 修订预算耗尽仍相似
    expect(aXhs.duplicates).toHaveLength(1);
    expect(aXhs.duplicates[0]).toMatchObject({ externalId: 'C', batchDate: HISTORY_DATE, similarity: 1 });
    expect(aXhs.note).toContain('相似');
    const bXhs = drafts.find((d) => d.externalId === 'B' && d.platform === 'xiaohongshu')!;
    expect(bXhs.status).toBe('draft');
    expect(bXhs.revisionCount).toBe(0);
    expect(bXhs.duplicates).toEqual([]);
    expect(result.revisions).toBe(2); // 只有 A 的两轮
    expect(result.duplicateHitCount).toBe(1);
  });

  it('近期已确认内容 → 注入生成请求作参考（避免重复角度）', async () => {
    const repo = await selectedRepo();
    await seedHistoryDraft(
      repo,
      'C',
      'xiaohongshu',
      { title: '历史参考标题', body: '完全不同的历史内容正文'.repeat(20), tags: ['历史', '参考', '记录'], coverIdea: null },
      'confirmed',
    );
    const capture: ContentRequest[] = [];
    await runContentGen({ repo, date: DATE, agent: fixedAgent({ capture }) });

    expect(capture).toHaveLength(2); // 无自检问题 → 不触发修订调用
    for (const req of capture) {
      expect(req.references).toEqual([{ platform: 'xiaohongshu', batchDate: HISTORY_DATE, title: '历史参考标题' }]);
    }
  });

  it('草稿结构不合规（body 过短）→ 修订无效 → 该平台 needs_manual', async () => {
    const repo = await selectedRepo();
    await runContentGen({ repo, date: DATE, agent: fixedAgent({ body: () => '太短' }) });

    const drafts = await repo.getContentDrafts(DATE);
    const xhs = drafts.find((d) => d.platform === 'xiaohongshu')!;
    expect(xhs.status).toBe('needs_manual');
    expect(xhs.content).toBeNull();
    expect(xhs.note).toContain('校验不过');
    expect(xhs.note).toContain('已修订 2 轮');
    const dy = drafts.find((d) => d.platform === 'douyin')!;
    expect(dy.status).toBe('draft'); // 合格的平台不受牵连
  });
});

describe('runContentGen：L2 审查（仅提示层）', () => {
  it('审查提示（pass=false）→ 草稿仍 draft，review 落库 + note 提示，不触发修订', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({
      repo,
      date: DATE,
      agent: fixedAgent(),
      reviewer: fixedReviewer({ risks: [{ type: 'exaggeration', detail: '"超出预期"缺数据支撑' }] }),
    });

    expect(result.generated).toBe(4);
    expect(result.reviewed).toBe(4);
    expect(result.revisions).toBe(0); // L2 不触发修订
    const drafts = await repo.getContentDrafts(DATE);
    for (const d of drafts) {
      expect(d.status).toBe('draft');
      expect(d.review?.pass).toBe(false);
      expect(d.review?.model).toBe('fixed-reviewer');
      expect(d.review?.risks).toHaveLength(1);
      expect(d.note).toContain('LLM 审查提示');
    }
  });

  it('审查通过 → review.pass=true 落库，无提示', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: fixedAgent(), reviewer: fixedReviewer() });

    expect(result.reviewed).toBe(4);
    const drafts = await repo.getContentDrafts(DATE);
    for (const d of drafts) {
      expect(d.review?.pass).toBe(true);
      expect(d.note).toBeNull();
    }
  });

  it('审查器异常 → 审查跳过（pass=null 留痕），流水线照常完成', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: fixedAgent(), reviewer: fixedReviewer({ throwErr: true }) });

    expect(result.generated).toBe(4);
    expect(result.reviewed).toBe(0);
    const drafts = await repo.getContentDrafts(DATE);
    for (const d of drafts) {
      expect(d.status).toBe('draft');
      expect(d.review?.pass).toBeNull();
      expect(d.review?.skippedReason).toContain('审查异常');
      expect(d.note).toBeNull(); // 审查跳过不产生提示
    }
    expect(await repo.countLlmCallsToday()).toBe(6); // 2 次生成 + 4 次审查失败（审计双路）
  });
});

describe('runContentGen：降级（内容不降级到模板）', () => {
  it('无 agent → 双版标记 needs_manual，流水线照常完成', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: null });

    expect(result.generated).toBe(0);
    expect(result.needsManual).toBe(4);
    expect(result.degraded).toBe(true);
    const drafts = await repo.getContentDrafts(DATE);
    expect(drafts).toHaveLength(4);
    expect(drafts.every((d) => d.status === 'needs_manual' && d.content === null)).toBe(true);
    expect(drafts.every((d) => d.note !== null)).toBe(true);
  });

  it('agent 抛异常 → needs_manual + 审计落库（ok=false）', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: fixedAgent({ throwErr: true }) });

    expect(result.needsManual).toBe(4);
    const calls = await repo.countLlmCallsToday();
    expect(calls).toBeGreaterThanOrEqual(2); // 2 品各记一条失败调用
    const drafts = await repo.getContentDrafts(DATE);
    expect(drafts.every((d) => d.note?.includes('agent 异常'))).toBe(true);
  });

  it('agent 单平台缺失 → 修订补齐无效后只缺的平台 needs_manual', async () => {
    const repo = await selectedRepo();
    const result = await runContentGen({ repo, date: DATE, agent: fixedAgent({ omitDouyin: true }) });

    expect(result.generated).toBe(2); // 小红书正常
    expect(result.needsManual).toBe(2); // 抖音缺失
    const drafts = await repo.getContentDrafts(DATE);
    const dy = drafts.find((d) => d.platform === 'douyin')!;
    expect(dy.status).toBe('needs_manual');
    expect(dy.revisionCount).toBe(2); // 缺失也占修订预算（有界重试）
  });

  it('needs_manual 重跑会重试（区别于 draft 的跳过）', async () => {
    const repo = await selectedRepo();
    await runContentGen({ repo, date: DATE, agent: fixedAgent({ omitDouyin: true }) });
    const retry = await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });

    expect(retry.generated).toBe(2); // 只补抖音
    expect(retry.skipped).toBe(2); // 小红书 draft 跳过
    const drafts = await repo.getContentDrafts(DATE);
    expect(drafts.every((d) => d.status === 'draft')).toBe(true);
  });
});
