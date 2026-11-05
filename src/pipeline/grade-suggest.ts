/**
 * 打档建议流水线（模块① V2 可选增强）：
 *   待评品（门槛过 + 三维缺）→ LLM 建议三维档位 + 依据 → 展示。
 *
 * 红线：建议不落库、不改分——打档唯一事实源是人工填的候选 CSV；
 * 人确认后改 CSV 重新 import-candidates + daily-scan 生效。
 * LLM 失败/超预算 → 提示人工打档，不阻塞任何流程（有价值的降级 = 不做）。
 */
import { validateSuggestions, type GradeAgent, type GradeProductInput, type GradeSuggestion } from '../agent/grade-agent.js';
import type { DailyListItem } from '../core/types.js';
import type { Repo } from '../db/repo.js';
import { todayShanghai } from '../util.js';

export interface GradeSuggestOptions {
  repo: Repo;
  date?: string;
  /** null = 未配置 LLM（返回待评清单 + 人工打档提示） */
  agent: GradeAgent | null;
  /** LLM 日预算（次）；与 daily-scan 共用同一条预算（第 5 层停止条件） */
  llmBudgetPerDay?: number;
}

export interface GradeSuggestResult {
  date: string;
  runId: string;
  /** 门槛已过、待打档（建议对象） */
  pendingGrading: Array<Pick<DailyListItem, 'externalId' | 'title' | 'flags'>>;
  /** 门槛未过的待评品（无需打档，仅列示） */
  gateFailed: Array<Pick<DailyListItem, 'externalId' | 'title' | 'flags'>>;
  suggestions: GradeSuggestion[];
  source: 'llm' | 'none';
  degraded: boolean;
  /** 预算熔断（第 5 层停止条件） */
  budgetExceeded: boolean;
}

/** 清单条目 → Agent 输入（只给判断需要的字段，三维缺失本身就是要补的） */
function toItemInput(i: DailyListItem): GradeProductInput {
  return {
    externalId: i.externalId,
    title: i.title,
    category: i.category,
    price: i.price,
    commissionRate: i.commissionRate,
    sales30d: i.sales30d,
    momTrend: i.momTrend,
    reviewRate: i.reviewRate,
  };
}

export async function runGradeSuggest(opts: GradeSuggestOptions): Promise<GradeSuggestResult> {
  const date = opts.date ?? todayShanghai();
  const repo = opts.repo;

  const list = await repo.getDailyList(date);
  if (!list) throw new Error(`${date} 没有候选清单，先执行 gwd daily-scan`);

  const pending = list.items.filter((i) => !i.complete);
  const pendingGrading = pending.filter((i) => i.gatePassed);
  const gateFailed = pending.filter((i) => !i.gatePassed);

  const base: Omit<GradeSuggestResult, 'suggestions' | 'source' | 'degraded' | 'budgetExceeded'> = {
    date,
    runId: list.runId,
    pendingGrading,
    gateFailed,
  };

  if (pendingGrading.length === 0) {
    return { ...base, suggestions: [], source: 'none', degraded: false, budgetExceeded: false };
  }

  // —— 预算熔断（与 daily-scan 同一条预算：一次打档建议 = 1 次调用）——
  let agent = opts.agent;
  let budgetExceeded = false;
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

  if (!agent) {
    return { ...base, suggestions: [], source: 'none', degraded: opts.agent != null, budgetExceeded };
  }

  const startedAt = Date.now();
  try {
    const result = await agent.suggest({
      runId: list.runId,
      products: pendingGrading.map(toItemInput),
    });
    // 服务层兜底校验（防御纵深）：不管 Agent 实现是否内部校验过，
    // externalId 必须在待评列表里、引用字段必须真实——伪造建议到此为止
    const products = pendingGrading.map(toItemInput);
    const suggestions = validateSuggestions(result.suggestions, products);
    const degraded = result.degraded || suggestions.length < result.suggestions.length;
    await repo.saveLlmLog({
      runId: list.runId,
      purpose: 'grade-suggest:grades',
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
    return { ...base, suggestions, source: 'llm', degraded, budgetExceeded: false };
  } catch (e) {
    await repo.saveLlmLog({
      runId: list.runId,
      purpose: 'grade-suggest:grades',
      model: agent.name,
      skill: 'grade-suggest',
      input: { error: 'agent-threw' },
      ok: false,
      error: String(e),
      latencyMs: Date.now() - startedAt,
    });
    return { ...base, suggestions: [], source: 'none', degraded: true, budgetExceeded: false };
  }
}
