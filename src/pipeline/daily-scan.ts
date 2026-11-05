/**
 * daily-scan 流水线（对应《单Agent最小方案》§6 时序）：
 *   [代码] 快照 → 黑名单过滤 → 门槛 → 打分 → 排序 → 落库
 *   [Agent] TopN 理由生成（LLM → 校验 → 降级模板）
 *   [收尾] submit（确定性步骤，永远执行，带审计）
 * 停止条件落点：maxSteps 在 Agent 内（硬限）；LLM 预算熔断在此检查（第 5 层）。
 */
import type { ReasonAgent } from '../agent/reason-agent.js';
import { rankScored, scoreProduct } from '../core/scoring.js';
import { templateReasons, type AgentReason } from '../core/template-reason.js';
import type { Repo, ScoreRecordRow } from '../db/repo.js';
import { todayShanghai } from '../util.js';

export interface DailyScanOptions {
  repo: Repo;
  date?: string;
  agent?: ReasonAgent | null;
  topN?: number;
  /** LLM 日预算（次）；超出则熔断走模板（停止条件第 5 层） */
  llmBudgetPerDay?: number;
  now?: () => Date;
}

export interface DailyScanResult {
  runId: string;
  date: string;
  ruleVersion: number;
  topCount: number;
  scoredCount: number;
  pendingCount: number;
  gateFailedCount: number;
  blacklistedCount: number;
  reasonSource: 'llm' | 'template' | 'mixed';
  degraded: boolean;
  stats: Record<string, unknown>;
}

export async function runDailyScan(opts: DailyScanOptions): Promise<DailyScanResult> {
  const date = opts.date ?? todayShanghai();
  const now = opts.now ?? (() => new Date());
  const repo = opts.repo;

  const rule = await repo.getActiveRule();
  if (!rule) throw new Error('没有 active 规则版本，先执行 `gwd rule init`');

  // 已勾选的日期不允许重跑（决策已挂在该日 run 上）
  const existing = await repo.getLatestRun(date);
  if (existing && existing.phase === 'selected') {
    throw new Error(`${date} 已完成勾选（run ${existing.id}），重跑会丢失决策关联。如确需重跑请换日期或人工处理。`);
  }

  const runId = await repo.createRun(date, rule.version);

  try {
    const snapshots = await repo.getSnapshotsByDate(date);
    if (snapshots.length === 0) {
      await repo.updateRun(runId, { phase: 'failed', status: 'failed', error: 'no_imported_data', finishedAt: now().toISOString() });
      throw new Error(`${date} 没有导入候选数据，先执行 gwd import-candidates <csv>`);
    }

    const blacklisted = snapshots.filter((s) => s.blacklisted);
    const active = snapshots.filter((s) => !s.blacklisted);

    // —— L1 确定性计算（无 LLM）——
    const scored = active.map((s) => scoreProduct(s.productId, s, rule));
    const { ranked } = rankScored(scored);
    // 待评 = 门槛已过但主观三维缺（真·待评，grade-suggest 的目标组）。
    // 门槛淘汰品单独计数——原 rankScored.pending 把门槛淘汰也算进"待评"，
    // 导致汇总行"待评 8、门槛淘汰 6"口径重叠（8 里含 6，两者相加超过打分数）。
    const pending = scored.filter((p) => p.gatePassed && !p.complete);

    const scoreRows: ScoreRecordRow[] = scored.map((p) => ({
      runId,
      productId: p.productId,
      ruleVersion: rule.version,
      gatePassed: p.gatePassed,
      gateResults: p.gates,
      dimensionScores: p.scores,
      total: p.total,
      complete: p.complete,
      grade: p.grade,
      flags: p.flags,
    }));
    await repo.saveScoreRecords(scoreRows);

    const topN = opts.topN ?? rule.topN;
    const top = ranked.slice(0, topN);
    const gateFailedCount = scored.filter((p) => !p.gatePassed).length;

    // —— LLM 预算熔断（停止条件第 5 层：预算门）——
    const requestedAgent = opts.agent ?? null;
    let budgetExceeded = false;
    let agent = requestedAgent;
    if (agent) {
      // env 乱值（如 'abc'）→ Number() 为 NaN，比较恒 false 会让熔断悄悄失效 → 兜底默认 50
      const raw = opts.llmBudgetPerDay ?? Number(process.env.GWD_LLM_BUDGET_CALLS_PER_DAY ?? 50);
      const budget = Number.isFinite(raw) ? raw : 50;
      const used = await repo.countLlmCallsToday();
      if (used >= budget) {
        agent = null;
        budgetExceeded = true;
      }
    }

    // —— Agent run（TopN 理由；失败降级模板）——
    let llmReasons: AgentReason[] = [];
    let agentDegraded = false;
    let agentName: string | null = null;
    if (agent && top.length > 0) {
      agentName = agent.name;
      const categories = [...new Set(top.map((p) => p.snapshot.category).filter((c): c is string => !!c))];
      const history = await repo.findSimilarProducts(categories, 5);
      const startedAt = Date.now();
      try {
        const result = await agent.generate({ runId, top, rule, history });
        llmReasons = result.reasons;
        agentDegraded = result.degraded;
        await repo.saveLlmLog({
          runId,
          purpose: 'daily-scan:reasons',
          model: result.audit.model,
          skill: result.audit.skill,
          input: { systemLength: String(result.audit.input ?? '').length, prompt: (result.audit.input as { prompt?: string } | null | undefined)?.prompt ?? null },
          output: result.audit.output,
          ok: true,
          latencyMs: Date.now() - startedAt,
        });
      } catch (e) {
        agentDegraded = true;
        await repo.saveLlmLog({
          runId,
          purpose: 'daily-scan:reasons',
          model: agentName,
          skill: 'daily-scan',
          input: { error: 'agent-threw' },
          ok: false,
          error: String(e),
          latencyMs: Date.now() - startedAt,
        });
      }
    }

    // —— 降级补位：LLM 缺谁补谁（有价值的降级）——
    const llmIds = new Set(llmReasons.map((r) => r.productId));
    const missing = top.filter((p) => !llmIds.has(p.productId));
    const filled = templateReasons(missing);
    const anyLlm = llmReasons.length > 0;
    const reasonSource: DailyScanResult['reasonSource'] =
      top.length === 0 ? 'template' : anyLlm && filled.length === 0 ? 'llm' : anyLlm ? 'mixed' : 'template';
    // 降级定义：请求了 LLM 但未完整产出（失败/超步数/超预算/部分缺失）。
    // 未配置 LLM 直接走模板 = 设计内默认，不算 degraded。
    const degraded = requestedAgent != null && (budgetExceeded || agentDegraded || filled.length > 0);

    await repo.saveReasons([
      ...llmReasons.map((r) => ({ runId, productId: r.productId, text: r.text, citedFields: r.citedFields, source: 'llm' as const })),
      ...filled.map((r) => ({ runId, productId: r.productId, text: r.text, citedFields: r.citedFields, source: 'template' as const })),
    ]);

    const stats = {
      snapshots: snapshots.length,
      blacklisted: blacklisted.length,
      scored: scored.length,
      gateFailed: gateFailedCount,
      ranked: ranked.length,
      pending: pending.length,
      topN,
      reasonSource,
      agent: agentName,
      agentDegraded,
      budgetExceeded,
      llmReasons: llmReasons.length,
      templateReasons: filled.length,
    };
    await repo.updateRun(runId, {
      phase: 'submitted',
      status: degraded ? 'degraded' : 'done',
      stats,
      finishedAt: now().toISOString(),
    });

    return {
      runId,
      date,
      ruleVersion: rule.version,
      topCount: top.length,
      scoredCount: scored.length,
      pendingCount: pending.length,
      gateFailedCount,
      blacklistedCount: blacklisted.length,
      reasonSource,
      degraded,
      stats,
    };
  } catch (e) {
    await repo.updateRun(runId, { phase: 'failed', status: 'failed', error: String(e), finishedAt: now().toISOString() });
    throw e;
  }
}
