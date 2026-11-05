import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import { createScriptedReasonAgent, type ReasonAgent } from '../agent/reason-agent.js';
import type { ProductSnapshot } from '../core/types.js';
import { runDailyScan } from './daily-scan.js';

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

/** 标准数据组：A 93 强推 / B 85 强推 / C 佣金门槛淘汰 / D 主观缺失待评 */
function standardRows(): ProductSnapshot[] {
  return [
    snap('A'),
    snap('B', { competition: 1 }), // 93 - 13 + 5 = 85
    snap('C', { commissionRate: 10 }),
    snap('D', { contentFriendliness: null, competition: null, repurchase: null }),
  ];
}

async function setup(rows: ProductSnapshot[] = standardRows(), date = DATE): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'test-init', approvedBy: 'tester' });
  if (rows.length > 0) await repo.upsertSnapshots(rows, date);
  return repo;
}

describe('runDailyScan：前置校验', () => {
  it('没有 active 规则 → 报错', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSnapshots(standardRows(), DATE);
    await expect(runDailyScan({ repo, date: DATE })).rejects.toThrow(/没有 active 规则版本/);
  });

  it('没有导入数据 → 报错且 run 落 failed', async () => {
    const repo = await setup([]);
    await expect(runDailyScan({ repo, date: DATE })).rejects.toThrow(/没有导入候选数据/);
    const run = await repo.getLatestRun(DATE);
    expect(run!.phase).toBe('failed');
    expect(run!.status).toBe('failed');
    expect(run!.error).toContain('没有导入候选数据'); // 外层 catch 统一记录最终异常
  });
});

describe('runDailyScan：主流水线', () => {
  it('无 Agent → 模板理由，reasonSource=template，不算降级', async () => {
    const repo = await setup();
    const result = await runDailyScan({ repo, date: DATE, agent: null });
    expect(result.scoredCount).toBe(4);
    expect(result.topCount).toBe(2);
    expect(result.pendingCount).toBe(1); // 仅 D（门槛过 + 三维缺）；门槛淘汰的 C 不再重复计入待评
    expect(result.gateFailedCount).toBe(1);
    expect(result.reasonSource).toBe('template');
    expect(result.degraded).toBe(false);

    const run = await repo.getLatestRun(DATE);
    expect(run!.phase).toBe('submitted');
    expect(run!.status).toBe('done');

    const list = await repo.getDailyList(DATE);
    const top = list!.items.filter((i) => i.gatePassed && i.complete);
    expect(top.map((i) => i.externalId)).toEqual(['A', 'B']);
    for (const i of top) {
      expect(i.reason).toBeTruthy();
      expect(i.reasonSource).toBe('template');
      expect(i.selected).toBe(false);
    }
  });

  it('脚本化 Agent → reasonSource=llm，完整产出不降级', async () => {
    const repo = await setup();
    const result = await runDailyScan({ repo, date: DATE, agent: createScriptedReasonAgent() });
    expect(result.reasonSource).toBe('llm');
    expect(result.degraded).toBe(false);
    const list = await repo.getDailyList(DATE);
    for (const i of list!.items.filter((x) => x.gatePassed && x.complete)) {
      expect(i.reasonSource).toBe('llm');
      expect(i.reason).toContain('佣金');
    }
  });

  it('Agent 抛异常 → 降级模板、记失败 LLM 审计', async () => {
    const repo = await setup();
    const boom: ReasonAgent = {
      name: 'boom',
      async generate() {
        throw new Error('LLM 挂了');
      },
    };
    const result = await runDailyScan({ repo, date: DATE, agent: boom });
    expect(result.degraded).toBe(true);
    expect(result.reasonSource).toBe('template');
    expect(await repo.countLlmCallsToday()).toBe(1);
    const run = await repo.getLatestRun(DATE);
    expect(run!.status).toBe('degraded');
  });

  it('Agent 只产出部分理由 → 缺谁补谁（mixed）且标记降级', async () => {
    const repo = await setup();
    const partial: ReasonAgent = {
      name: 'partial',
      async generate(req) {
        const only = req.top[0]!;
        return {
          reasons: [{ productId: only.productId, text: '部分理由'.padEnd(25, '。'), citedFields: ['total'] }],
          submitted: true,
          degraded: false,
          audit: { purpose: 't', model: 'partial', skill: 't', input: null, output: null },
        };
      },
    };
    const result = await runDailyScan({ repo, date: DATE, agent: partial });
    expect(result.reasonSource).toBe('mixed');
    expect(result.degraded).toBe(true);
    const list = await repo.getDailyList(DATE);
    const sources = list!.items.filter((x) => x.gatePassed && x.complete).map((x) => x.reasonSource);
    expect(sources.sort()).toEqual(['llm', 'template']);
  });

  it('LLM 预算熔断（第 5 层停止条件）→ 不调 Agent 直接模板', async () => {
    const repo = await setup();
    const boom: ReasonAgent = {
      name: 'boom',
      async generate() {
        throw new Error('不应该被调用');
      },
    };
    const result = await runDailyScan({ repo, date: DATE, agent: boom, llmBudgetPerDay: 0 });
    expect(result.degraded).toBe(true);
    expect(result.reasonSource).toBe('template');
    expect((result.stats as { budgetExceeded: boolean }).budgetExceeded).toBe(true);
    expect(await repo.countLlmCallsToday()).toBe(0); // 没有发起调用
  });

  it('topN 截断：第 N+1 名入榜但不生成理由', async () => {
    const repo = await setup();
    const result = await runDailyScan({ repo, date: DATE, agent: null, topN: 1 });
    expect(result.topCount).toBe(1);
    const list = await repo.getDailyList(DATE);
    const ranked = list!.items.filter((x) => x.gatePassed && x.complete);
    expect(ranked[0]!.externalId).toBe('A');
    expect(ranked[0]!.reason).toBeTruthy();
    expect(ranked[1]!.reason).toBeNull(); // 榜上第 2 名不在 TopN，无理由
  });
});

describe('runDailyScan：重跑保护', () => {
  it('已勾选（selected）的日期拒绝重跑', async () => {
    const repo = await setup();
    await runDailyScan({ repo, date: DATE, agent: null });
    const list = await repo.getDailyList(DATE);
    const first = list!.items.find((i) => i.gatePassed && i.complete)!;
    const { selectProducts } = await import('./select.js');
    await selectProducts({ repo, date: DATE, externalIds: [first.externalId] });
    await expect(runDailyScan({ repo, date: DATE, agent: null })).rejects.toThrow(/已完成勾选/);
  });

  it('未勾选的日期可以重跑（新 run 覆盖清单）', async () => {
    const repo = await setup();
    await runDailyScan({ repo, date: DATE, agent: null });
    const again = await runDailyScan({ repo, date: DATE, agent: null });
    expect(again.topCount).toBe(2);
    const runs = [await repo.getLatestRun(DATE)];
    expect(runs[0]!.phase).toBe('submitted');
  });
});
