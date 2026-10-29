import { describe, expect, it } from 'vitest';
import { MemoryRepo } from './memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';

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

const DATE = '2026-01-05';

describe('MemoryRepo：导入与快照', () => {
  it('upsertSnapshots 首次 inserted；同商品同日重导 → updated（幂等覆盖）', async () => {
    const repo = new MemoryRepo();
    const first = await repo.upsertSnapshots([snap('P1'), snap('P2')], DATE);
    expect(first).toEqual({ inserted: 2, updated: 0 });
    const second = await repo.upsertSnapshots([snap('P1', { title: '修正标题' }), snap('P3')], DATE);
    expect(second).toEqual({ inserted: 1, updated: 1 });

    const rows = await repo.getSnapshotsByDate(DATE);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.externalId === 'P1')!.title).toBe('修正标题');
    expect(rows.every((r) => r.blacklisted === false)).toBe(true);
  });

  it('getSnapshotsByDate 只返回当日快照', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSnapshots([snap('P1')], DATE);
    await repo.upsertSnapshots([snap('P2')], '2026-01-06');
    expect((await repo.getSnapshotsByDate(DATE)).map((r) => r.externalId)).toEqual(['P1']);
  });
});

describe('MemoryRepo：规则版本链', () => {
  it('applyRuleVersion 自动递增并 supersede 旧版本；rollback 可回退', async () => {
    const repo = new MemoryRepo();
    const v1 = await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    expect(v1).toBe(1);
    const modified = structuredClone(RULE_V1);
    modified.gates.minCommissionRate = 18;
    const v2 = await repo.applyRuleVersion(modified, { reason: '提门槛', approvedBy: 't' });
    expect(v2).toBe(2);

    const active = await repo.getActiveRule();
    expect(active!.gates.minCommissionRate).toBe(18);

    const versions = await repo.listRuleVersions();
    expect(versions.map((v) => `${v.version}:${v.status}`)).toEqual(['2:active', '1:superseded']);

    const rb = await repo.rollbackRule();
    expect(rb).toEqual({ from: 2, to: 1 });
    expect((await repo.getActiveRule())!.gates.minCommissionRate).toBe(15);
  });

  it('rollback 到头会报错', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await expect(repo.rollbackRule()).rejects.toThrow(/没有可回滚/);
  });

  it('getActiveRule 返回克隆，外部修改不污染内部', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    const a = await repo.getActiveRule();
    a!.gates.minReviewRate = 1;
    const b = await repo.getActiveRule();
    expect(b!.gates.minReviewRate).toBe(85);
  });
});

describe('MemoryRepo：run 与清单', () => {
  it('createRun / updateRun / getLatestRun', async () => {
    const repo = new MemoryRepo();
    const id = await repo.createRun(DATE, 1);
    await repo.updateRun(id, { phase: 'submitted', status: 'done', finishedAt: '2026-01-05T01:00:00Z' });
    const run = await repo.getLatestRun(DATE);
    expect(run!.id).toBe(id);
    expect(run!.phase).toBe('submitted');
    expect(run!.status).toBe('done');
  });

  it('saveDecisions 幂等（重复勾选不产生重复决策行）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSnapshots([snap('P1'), snap('P2')], DATE);
    const rows = await repo.getSnapshotsByDate(DATE);
    const runId = await repo.createRun(DATE, 1);
    await repo.saveScoreRecords([
      { runId, productId: rows[0]!.productId, ruleVersion: 1, gatePassed: true, gateResults: [], dimensionScores: {}, total: 93, complete: true, grade: 'strong', flags: [] },
    ]);
    const decision = {
      runId,
      batchDate: DATE,
      productId: rows[0]!.productId,
      action: 'selected' as const,
      decidedBy: 'human',
      ruleVersion: 1,
      totalScore: 93,
    };
    await repo.saveDecisions([decision]);
    await repo.saveDecisions([decision]); // 重复
    // 用 findSimilarProducts 验证只沉淀一条（它要求打分记录存在）
    const similar = await repo.findSimilarProducts(['家居收纳'], 10);
    expect(similar).toHaveLength(1);
  });

  it('getDailyList 组装打分/理由/勾选状态', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    await repo.upsertSnapshots([snap('P1'), snap('P2', { commissionRate: 10 })], DATE);
    const rows = await repo.getSnapshotsByDate(DATE);
    const runId = await repo.createRun(DATE, 1);
    await repo.saveScoreRecords(
      rows.map((r) => ({
        runId,
        productId: r.productId,
        ruleVersion: 1,
        gatePassed: r.commissionRate! > 15,
        gateResults: [],
        dimensionScores: {},
        total: 93,
        complete: true,
        grade: 'strong',
        flags: [],
      })),
    );
    await repo.saveReasons([
      { runId, productId: rows[0]!.productId, text: '理由', citedFields: ['total'], source: 'llm' },
    ]);
    await repo.saveDecisions([
      { runId, batchDate: DATE, productId: rows[0]!.productId, action: 'selected', decidedBy: 'human' },
    ]);

    const list = await repo.getDailyList(DATE);
    expect(list!.runId).toBe(runId);
    expect(list!.items).toHaveLength(2);
    const p1 = list!.items.find((i) => i.externalId === 'P1')!;
    expect(p1.reason).toBe('理由');
    expect(p1.reasonSource).toBe('llm');
    expect(p1.selected).toBe(true);
    const p2 = list!.items.find((i) => i.externalId === 'P2')!;
    expect(p2.gatePassed).toBe(false);
    expect(p2.reason).toBeNull();
  });
});
