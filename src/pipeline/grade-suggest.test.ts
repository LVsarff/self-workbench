/**
 * 打档建议（模块① V2 可选增强）测试：建议产出 / 不落库红线 / 降级与预算 / 校验净化。
 * 核心红线：建议不落库不改分——打档唯一事实源是人工 CSV，跑完建议后快照三维必须原样。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import { runDailyScan } from './daily-scan.js';
import { runGradeSuggest } from './grade-suggest.js';
import { buildGradePrompt, validateSuggestions, type GradeAgent, type GradeProductInput } from '../agent/grade-agent.js';

const DATE = '2026-01-05';

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

/** 已跑 daily-scan 的仓储；pending 品 = 三维缺 + 门槛过，gateFail 品 = 三维缺 + 门槛不过 */
async function scannedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots(
    [
      snap('A'),
      snap('PENDING', { contentFriendliness: null, competition: null, repurchase: null }),
      snap('GATEFAIL', { commissionRate: 5, contentFriendliness: null, competition: null, repurchase: null }),
    ],
    DATE,
  );
  await runDailyScan({ repo, date: DATE, agent: null });
  return repo;
}

/** 脚本化假 Agent：固定输出（走真实校验路径） */
function fakeAgent(over: Partial<Parameters<GradeAgent['suggest']>[0]> = {}): GradeAgent {
  return {
    name: 'fake',
    async suggest(req) {
      const suggestions = req.products.map((p) => ({
        externalId: p.externalId,
        contentFriendliness: 5,
        competition: 3,
        repurchase: 4,
        rationale: '家居收纳类目视觉展示强、场景丰富，按类目先验给档。',
        citedFields: ['category', 'commission_rate'],
      }));
      return {
        suggestions,
        degraded: suggestions.length < req.products.length,
        audit: {
          purpose: 'grade-suggest:grades',
          model: 'fake',
          skill: 'grade-suggest@1',
          input: { prompt: 'fake-prompt' },
          output: { valid: suggestions.length },
        },
      };
    },
  };
}

describe('runGradeSuggest：建议产出与分组', () => {
  it('门槛过的待评品进建议组；门槛未过的只列示不进建议', async () => {
    const repo = await scannedRepo();
    const result = await runGradeSuggest({ repo, date: DATE, agent: fakeAgent() });
    expect(result.pendingGrading.map((p) => p.externalId)).toEqual(['PENDING']);
    expect(result.gateFailed.map((p) => p.externalId)).toEqual(['GATEFAIL']);
    expect(result.source).toBe('llm');
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ externalId: 'PENDING', contentFriendliness: 5, competition: 3, repurchase: 4 });
  });

  it('红线：建议不落库不改分——跑完建议后快照三维仍为 null，分数记录不变', async () => {
    const repo = await scannedRepo();
    const before = (await repo.getSnapshotsByDate(DATE)).find((s) => s.externalId === 'PENDING')!;
    expect(before.contentFriendliness).toBeNull();
    const listBefore = (await repo.getDailyList(DATE))!.items.find((i) => i.externalId === 'PENDING')!;
    const totalBefore = listBefore.total;

    await runGradeSuggest({ repo, date: DATE, agent: fakeAgent() });

    const after = (await repo.getSnapshotsByDate(DATE)).find((s) => s.externalId === 'PENDING')!;
    expect(after.contentFriendliness).toBeNull();
    expect(after.competition).toBeNull();
    expect(after.repurchase).toBeNull();
    const listAfter = (await repo.getDailyList(DATE))!.items.find((i) => i.externalId === 'PENDING')!;
    expect(listAfter.total).toBe(totalBefore);
    expect(listAfter.complete).toBe(false); // 仍是待评，没有偷偷入榜
  });

  it('三维全齐（无待评）→ source none，不调 LLM', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    const result = await runGradeSuggest({ repo, date: DATE, agent: fakeAgent() });
    expect(result.source).toBe('none');
    expect(result.pendingGrading).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('没有清单 → 抛错（先 daily-scan）', async () => {
    const repo = new MemoryRepo();
    await expect(runGradeSuggest({ repo, date: '2030-01-01', agent: fakeAgent() })).rejects.toThrow(/先执行 gwd daily-scan/);
  });
});

describe('runGradeSuggest：降级与预算（停止条件）', () => {
  it('未配置 LLM（agent null）→ source none，设计内默认不算 degraded', async () => {
    const repo = await scannedRepo();
    const result = await runGradeSuggest({ repo, date: DATE, agent: null });
    expect(result.source).toBe('none');
    expect(result.degraded).toBe(false);
    expect(result.pendingGrading).toHaveLength(1); // 待评品照常列出，人工打档
  });

  it('LLM 日预算用尽 → 熔断不调用，budgetExceeded 标记', async () => {
    const repo = await scannedRepo();
    const result = await runGradeSuggest({ repo, date: DATE, agent: fakeAgent(), llmBudgetPerDay: 0 });
    expect(result.source).toBe('none');
    expect(result.budgetExceeded).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.suggestions).toEqual([]);
  });

  it('Agent 抛错 → 降级 + llm_call_logs 记失败（ok=false）', async () => {
    const repo = await scannedRepo();
    const boom: GradeAgent = {
      name: 'boom',
      async suggest() {
        throw new Error('LLM down');
      },
    };
    const result = await runGradeSuggest({ repo, date: DATE, agent: boom });
    expect(result.source).toBe('none');
    expect(result.degraded).toBe(true);
    const logs = (repo as unknown as { llmLogs: Array<{ purpose: string; ok: boolean; error: string | null }> }).llmLogs;
    const mine = logs.filter((l) => l.purpose === 'grade-suggest:grades');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.ok).toBe(false);
    expect(mine[0]!.error).toContain('LLM down');
  });

  it('成功调用 → llm_call_logs 审计落库（purpose/model/latency）', async () => {
    const repo = await scannedRepo();
    await runGradeSuggest({ repo, date: DATE, agent: fakeAgent() });
    const logs = (repo as unknown as { llmLogs: Array<{ purpose: string; model: string; skill: string; ok: boolean }> }).llmLogs;
    const mine = logs.filter((l) => l.purpose === 'grade-suggest:grades');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.model).toBe('fake');
    expect(mine[0]!.skill).toBe('grade-suggest@1');
    expect(mine[0]!.ok).toBe(true);
  });
});

describe('validateSuggestions：校验净化（防幻觉锚点）', () => {
  const products: GradeProductInput[] = [
    { externalId: 'A', title: '商品A', category: '家居', price: 39.9, commissionRate: 25, sales30d: 3200, momTrend: 'up', reviewRate: 96 },
  ];

  it('伪造 externalId → 丢弃', () => {
    const out = validateSuggestions(
      [{ externalId: 'NOT_EXIST', contentFriendliness: 5, competition: 3, repurchase: 4, rationale: 'x'.repeat(20), citedFields: ['category'] }],
      products,
    );
    expect(out).toEqual([]);
  });

  it('引用字段全伪造 → 丢弃；部分伪造 → 过滤保留合法项', () => {
    const out = validateSuggestions(
      [
        { externalId: 'A', contentFriendliness: 5, competition: 3, repurchase: 4, rationale: 'x'.repeat(20), citedFields: ['made_up_field'] },
        { externalId: 'A', contentFriendliness: 4, competition: 3, repurchase: 3, rationale: 'y'.repeat(20), citedFields: ['category', 'fake_field'] },
      ],
      products,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.citedFields).toEqual(['category']);
  });

  it('合法建议原样保留', () => {
    const input = [{ externalId: 'A', contentFriendliness: 5, competition: 3, repurchase: 4, rationale: 'z'.repeat(20), citedFields: ['price', 'review_rate'] }];
    expect(validateSuggestions(input, products)).toEqual(input);
  });
});

describe('buildGradePrompt：输入净化', () => {
  it('商家可控文本截断：超长标题带截断标记，不整段进 prompt', () => {
    const req = {
      runId: 'run-1',
      products: [
        {
          externalId: 'A',
          title: 'a'.repeat(500),
          category: 'b'.repeat(200),
          price: 39.9,
          commissionRate: 25,
          sales30d: 3200,
          momTrend: 'up',
          reviewRate: 96,
        },
      ],
    };
    const { prompt } = buildGradePrompt(req);
    expect(prompt).toContain('…[截断]');
    expect(prompt).not.toContain('a'.repeat(200)); // 原始超长串没整段进 prompt
  });

  it('待评品字段注入（external_id / 佣金 / 销量可见）', () => {
    const { prompt } = buildGradePrompt({
      runId: 'run-1',
      products: [{ externalId: 'P1', title: '商品P1', category: '厨房', price: 29.9, commissionRate: 22, sales30d: 1800, momTrend: 'up', reviewRate: 95 }],
    });
    expect(prompt).toContain('"external_id": "P1"');
    expect(prompt).toContain('"commission_rate": 22');
    expect(prompt).toContain('submit_grades');
  });
});
