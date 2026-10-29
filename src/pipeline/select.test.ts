import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import { runDailyScan } from './daily-scan.js';
import { selectProducts } from './select.js';

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

/** 已跑完 daily-scan 的仓储：A/B 入榜，C 门槛淘汰 */
async function submittedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B', { competition: 1 }), snap('C', { commissionRate: 10 })], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  return repo;
}

describe('selectProducts：前置校验', () => {
  it('没有清单 → 报错', async () => {
    const repo = new MemoryRepo();
    await expect(selectProducts({ repo, date: DATE, externalIds: ['A'] })).rejects.toThrow(/没有候选清单/);
  });

  it('清单未完成（phase=scoring）→ 不可勾选', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSnapshots([snap('A')], DATE);
    await repo.createRun(DATE, 1); // 只建 run 不推进 phase
    await expect(selectProducts({ repo, date: DATE, externalIds: ['A'] })).rejects.toThrow(/不可勾选/);
  });

  it('未知商品 ID → 报错并列出', async () => {
    const repo = await submittedRepo();
    await expect(selectProducts({ repo, date: DATE, externalIds: ['A', 'NOPE'] })).rejects.toThrow(/NOPE/);
  });
});

describe('selectProducts：勾选门', () => {
  it('勾选入榜商品 → 决策落库、run 转 selected、清单标记', async () => {
    const repo = await submittedRepo();
    const result = await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'], note: '今天做这两个' });
    expect(result.selected.sort()).toEqual(['A', 'B']);
    expect(result.alreadySelected).toEqual([]);

    const run = await repo.getLatestRun(DATE);
    expect(run!.phase).toBe('selected');

    const list = await repo.getDailyList(DATE);
    expect(list!.items.find((i) => i.externalId === 'A')!.selected).toBe(true);
    expect(list!.items.find((i) => i.externalId === 'B')!.selected).toBe(true);

    // 决策沉淀为历史相似品（下一个 run 的 Agent 输入）
    const similar = await repo.findSimilarProducts(['家居收纳'], 10);
    expect(similar.map((s) => s.externalId).sort()).toEqual(['A', 'B']);
  });

  it('重复勾选幂等：已勾的跳过，不重复落决策', async () => {
    const repo = await submittedRepo();
    await selectProducts({ repo, date: DATE, externalIds: ['A'] });
    const again = await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
    expect(again.selected).toEqual(['B']);
    expect(again.alreadySelected).toEqual(['A']);
    const similar = await repo.findSimilarProducts(['家居收纳'], 10);
    expect(similar).toHaveLength(2); // A 只沉淀一条
  });

  it('门槛淘汰品也能勾选（人可以推翻 L1 规则，审计留痕）', async () => {
    const repo = await submittedRepo();
    const result = await selectProducts({ repo, date: DATE, externalIds: ['C'] });
    expect(result.selected).toEqual(['C']);
    const list = await repo.getDailyList(DATE);
    expect(list!.items.find((i) => i.externalId === 'C')!.selected).toBe(true);
  });
});
