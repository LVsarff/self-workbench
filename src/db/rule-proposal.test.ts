/**
 * 模块⑤ 结论回写闭环（建议 → 人批准 → 版本化生效 → 可回滚）语义测试。
 * 红线（门⑤）逐条锁死：
 * - 系统永不自行生效提案：pending 不动 active；approve 才走版本链
 * - 单向一次决策：approved/rejected 不可再决策（幂等拒绝）
 * - 批准时刻重新校验：提案创建合法不代表批准时仍合法
 * - 可回滚：批准生成的 resulting_version 可 gwd rule rollback
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from './memory-repo.js';
import { RULE_V1, parseRuleConfig } from '../core/rule-config.js';
import type { RuleConfig } from '../core/rule-config.js';
import type { RuleProposalRow } from './repo.js';

/** 基于 RULE_V1 的合法变体：佣金门槛 15 → 18（其余不动，权重和不变） */
function variantConfig(): RuleConfig {
  return { ...RULE_V1, version: RULE_V1.version + 1, gates: { ...RULE_V1.gates, minCommissionRate: 18 } };
}

/** 非法变体：佣金打分合计 101（过不了 validateBusinessRule） */
function tamperedConfig(): RuleConfig {
  return { ...RULE_V1, scoring: { ...RULE_V1.scoring, commission: [{ min: 30, score: 101 }] } };
}

async function setup(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'test-init', approvedBy: 'tester' });
  return repo;
}

describe('提案生命周期', () => {
  it('创建 → pending，不碰 active 规则', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: 'sim-weekly 2026-11-05 曝光跌 30% 触发', expectedEffect: '下周曝光回升', config: variantConfig() });
    expect(row.status).toBe('pending');
    expect((await repo.getActiveRule())!.gates.minCommissionRate).toBe(15);
  });

  it('创建时校验 config：非法配置不让进门', async () => {
    const repo = await setup();
    await expect(repo.createRuleProposal({ basis: 'x', config: tamperedConfig() })).rejects.toThrow('校验失败');
  });

  it('approve → 走版本链生效 + 回填 resulting_version + reason 带提案锚点', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: '佣金阈值上调观察', config: variantConfig() });
    const decided = await repo.decideRuleProposal(row.id, { action: 'approve', decidedBy: 'human-cli' });
    expect(decided.status).toBe('approved');
    expect(decided.resultingVersion).toBe(2);
    const active = (await repo.getActiveRule())!;
    expect(active.gates.minCommissionRate).toBe(18);
    expect(active.version).toBe(2);
    const versions = await repo.listRuleVersions();
    expect(versions[0]!.changeReason).toContain(`提案 ${row.id}`);
    // 批准生效后可回滚（闭环的最后一环）
    const rb = await repo.rollbackRule();
    expect(rb).toEqual({ from: 2, to: 1 });
    expect((await repo.getActiveRule())!.gates.minCommissionRate).toBe(15);
  });

  it('reject → 留档，active 不动，rejected 不可再决策', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: '不采纳的观察', config: variantConfig() });
    const decided = await repo.decideRuleProposal(row.id, { action: 'reject', decidedBy: 'human-cli' });
    expect(decided.status).toBe('rejected');
    expect(decided.resultingVersion).toBeNull();
    expect((await repo.getActiveRule())!.version).toBe(1);
    await expect(repo.decideRuleProposal(row.id, { action: 'approve', decidedBy: 'human-cli' })).rejects.toThrow('不能重复决策');
  });

  it('approved 不可再决策（幂等拒绝，审计单向一次）', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: 'x', config: variantConfig() });
    await repo.decideRuleProposal(row.id, { action: 'approve', decidedBy: 'human-cli' });
    await expect(repo.decideRuleProposal(row.id, { action: 'approve', decidedBy: 'human-cli' })).rejects.toThrow('不能重复决策');
    await expect(repo.decideRuleProposal(row.id, { action: 'reject', decidedBy: 'human-cli' })).rejects.toThrow('不能重复决策');
  });

  it('不存在的提案 → 报错；列表按时间倒序', async () => {
    const repo = await setup();
    await expect(repo.decideRuleProposal('prop-999', { action: 'approve', decidedBy: 'x' })).rejects.toThrow('不存在');
    await repo.createRuleProposal({ basis: '第一', config: variantConfig() });
    await repo.createRuleProposal({ basis: '第二', config: variantConfig() });
    const list = await repo.listRuleProposals();
    expect(list).toHaveLength(2);
    expect(list[0]!.basis).toBe('第二');
  });

  it('config 深拷贝：提案登记后外部改对象不影响仓库内留存', async () => {
    const repo = await setup();
    const cfg = variantConfig();
    const row = await repo.createRuleProposal({ basis: 'x', config: cfg });
    cfg.gates.minCommissionRate = 99;
    const got = (await repo.getRuleProposal(row.id)) as RuleProposalRow;
    expect(got.config.gates.minCommissionRate).toBe(18);
  });
});

describe('提案 config 的批准时刻校验', () => {
  it('合法提案在版本链演进后仍可批准（以批准时刻的链为准）', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: 'x', config: variantConfig() });
    // 提案躺了一段时间，期间有人直接 rule apply 了 v2
    await repo.applyRuleVersion({ ...RULE_V1, version: 2, gates: { ...RULE_V1.gates, minMerchantScore: 75 } }, { reason: '直接调整', approvedBy: 'tester' });
    const decided = await repo.decideRuleProposal(row.id, { action: 'approve', decidedBy: 'human-cli' });
    // 批准生成 v3，提案 config 重新校验通过后覆盖生效
    expect(decided.resultingVersion).toBe(3);
    expect((await repo.getActiveRule())!.gates.minCommissionRate).toBe(18);
  });

  it('批准时刻 config 已损坏 → 拒绝执行且提案保持 pending', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: 'x', config: variantConfig() });
    // 模拟库内损坏（绕过入口校验直接改内存行）
    const internal = (repo as unknown as { ruleProposals: Array<{ id: string; config: RuleConfig }> }).ruleProposals.find((p) => p.id === row.id)!;
    internal.config = tamperedConfig();
    await expect(repo.decideRuleProposal(row.id, { action: 'approve', decidedBy: 'human-cli' })).rejects.toThrow('批准时刻');
    const after = (await repo.getRuleProposal(row.id))!;
    expect(after.status).toBe('pending'); // 失败不产生半状态
    expect((await repo.getActiveRule())!.version).toBe(1); // active 未被污染
  });
});

describe('与 parseRuleConfig 的一致性', () => {
  it('提案创建前后的 config 均通过 parseRuleConfig', async () => {
    const repo = await setup();
    const row = await repo.createRuleProposal({ basis: 'x', config: variantConfig() });
    expect(parseRuleConfig(row.config).ok).toBe(true);
    const got = await repo.getRuleProposal(row.id);
    expect(parseRuleConfig(got!.config).ok).toBe(true);
  });
});
