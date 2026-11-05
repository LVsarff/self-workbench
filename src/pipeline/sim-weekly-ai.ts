/**
 * 周报 AI 叙事流水线（模块⑤ 第二批）：零 LLM 骨架之上加 LLM 层。
 *   runSimWeekly（零 LLM 骨架）→ Agent 叙事 + 规则 patch 建议 →
 *   系统合成完整 config（applyRulePatches）→ 产物直接兼容 gwd rule propose。
 *
 * 红线：
 * - LLM 失败/超预算/校验丢弃 → 降级为零 LLM 骨架呈现（有价值的降级）
 * - AI 建议只是提案草案：人审 → gwd rule propose <file> → gwd rule approve 才生效
 * - 模拟数据输出必带「模拟数据 · 方法已验证、参数未验证」声明
 */
import { applyRulePatches, type AiRuleSuggestion, type WeeklyAgent } from '../agent/weekly-agent.js';
import type { RuleConfig } from '../core/rule-config.js';
import type { Repo } from '../db/repo.js';
import { runSimWeekly, type SimWeeklyOptions, type SimWeeklyReport } from './sim-weekly.js';

/** rule propose 兼容的提案草案（{basis, expectedEffect, config}） */
export interface RuleProposalDraft {
  basis: string;
  expectedEffect: string;
  config: RuleConfig;
}

export interface SimWeeklyAIResult {
  /** 零 LLM 骨架（永远可用，LLM 层只是加在其上） */
  report: SimWeeklyReport;
  /** 建议 diff 的基准（展示参数变更用） */
  activeRule: RuleConfig;
  /** AI 叙事（null = 降级为零 LLM 骨架） */
  narrative: { summary: string } | null;
  narrativeSource: 'llm' | 'none';
  /** 规则提案草案（每条已合成完整 config，直接可写 rule propose JSON） */
  proposals: RuleProposalDraft[];
  /** 请求了 LLM 但未完整产出（失败/超预算/部分丢弃） */
  degraded: boolean;
  /** 预算熔断（LLM 日预算用尽，未发起调用） */
  budgetExceeded: boolean;
}

export interface SimWeeklyAIOptions extends Omit<SimWeeklyOptions, 'repo'> {
  repo: Repo;
  /** null = 未配置 LLM（纯零 LLM 骨架） */
  agent: WeeklyAgent | null;
  /** LLM 日预算（次）；与 daily-scan / grade-suggest 共用同一条预算 */
  llmBudgetPerDay?: number;
}

/** AI 建议 + active 规则 → 提案草案（config 合成失败的建议已在 Agent 层被丢弃，这里不再发生） */
export function toProposalDrafts(
  suggestions: AiRuleSuggestion[],
  rule: RuleConfig,
): RuleProposalDraft[] {
  const out: RuleProposalDraft[] = [];
  for (const s of suggestions) {
    const applied = applyRulePatches(rule, s.patches);
    if (!applied.ok) continue; // 防御纵深：Agent 校验后原则上不会到这
    out.push({ basis: s.basis, expectedEffect: s.expectedEffect, config: applied.config });
  }
  return out;
}

export async function runSimWeeklyAI(opts: SimWeeklyAIOptions): Promise<SimWeeklyAIResult> {
  const report = await runSimWeekly({ repo: opts.repo, authorId: opts.authorId, weekEnd: opts.weekEnd });

  const rule = await opts.repo.getActiveRule();
  if (rule == null) {
    throw new Error('没有 active 规则，先执行 gwd rule init（AI 规则建议需要规则基准）');
  }

  const base = { report, activeRule: rule, narrativeSource: 'none' as const, proposals: [] as RuleProposalDraft[] };

  let agent = opts.agent;
  let budgetExceeded = false;
  if (agent) {
    // env 乱值 → NaN 比较恒 false 会让熔断悄悄失效 → 兜底默认 50（与 grade-suggest 同策略）
    const raw = opts.llmBudgetPerDay ?? Number(process.env.GWD_LLM_BUDGET_CALLS_PER_DAY ?? 50);
    const budget = Number.isFinite(raw) ? raw : 50;
    const used = await opts.repo.countLlmCallsToday();
    if (used >= budget) {
      agent = null;
      budgetExceeded = true;
    }
  }
  if (!agent) {
    return { ...base, narrative: null, degraded: opts.agent != null, budgetExceeded };
  }

  const startedAt = Date.now();
  try {
    const result = await agent.generate({ report, rule });
    await opts.repo.saveLlmLog({
      purpose: 'weekly-narrative:report',
      model: result.audit.model,
      skill: result.audit.skill,
      input: {
        systemLength: String(result.audit.input ?? '').length,
        prompt: (result.audit.input as { prompt?: string } | null | undefined)?.prompt ?? null,
      },
      output: result.audit.output,
      ok: true,
      latencyMs: Date.now() - startedAt,
    });
    return {
      report,
      activeRule: rule,
      narrative: result.narrative,
      narrativeSource: result.narrative != null ? 'llm' : 'none',
      proposals: toProposalDrafts(result.ruleSuggestions, rule),
      degraded: result.degraded,
      budgetExceeded: false,
    };
  } catch (e) {
    await opts.repo.saveLlmLog({
      purpose: 'weekly-narrative:report',
      model: agent.name,
      skill: 'weekly-narrative',
      input: { error: 'agent-threw' },
      ok: false,
      error: String(e),
      latencyMs: Date.now() - startedAt,
    });
    return { ...base, narrative: null, degraded: true, budgetExceeded: false };
  }
}

