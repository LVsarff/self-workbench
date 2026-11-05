/**
 * 深度调研摘要流水线（模块① V2 收官）：
 *   人工抄录原文（txt）→ LLM 结构化摘要（舆情/风险/素材点）→ 落库存档（一品一份）。
 *
 * 消费方：内容工坊（content-gen 生成时注入该品摘要段——买家真实关注点 = 素材）。
 * 红线：摘要是参考不是事实——人终判；原文商家可控，进 prompt 前截断；
 *       无 key / LLM 失败 / 超预算 → 明确提示人工整理，不阻塞任何流程。
 * 幂等：一品一份（product_id 唯一）；重做须 --force（原文与摘要同换，留审计）。
 */
import type { ResearchAgent } from '../agent/research-agent.js';
import { clipSourceText, ResearchSummarySchema } from '../agent/research-agent.js';
import type { Repo, ResearchRow, ResearchSummary } from '../db/repo.js';
import { todayShanghai } from '../util.js';

/** 原文太短没有摘要价值（空 / 几个字的碎片） */
export const SOURCE_TEXT_MIN = 50;

export interface ResearchOptions {
  repo: Repo;
  externalId: string;
  /** 人工抄录原文（已读入的文本） */
  sourceText: string;
  /** null = 未配置 LLM */
  agent: ResearchAgent | null;
  /** 重做已有摘要（覆盖：原文与摘要同换） */
  force?: boolean;
  /** LLM 日预算（次）；与 daily-scan 共用（第 5 层停止条件） */
  llmBudgetPerDay?: number;
}

export interface ResearchResult {
  externalId: string;
  productId: string;
  summary: ResearchSummary;
  /** 截断后存档的原文长度 */
  sourceTextChars: number;
  /** 原文超长被截断 */
  truncated: boolean;
}

export async function runResearch(opts: ResearchOptions): Promise<ResearchResult> {
  const repo = opts.repo;

  const productId = await repo.findProductIdByExternalId(opts.externalId);
  if (productId == null) throw new Error(`没有找到商品 ${opts.externalId}（先 import-candidates）`);

  // NUL 清洗：pg text 类型不接受 \x00（网页复制可能带进垃圾字节），入口剥掉再走后续
  const sanitized = opts.sourceText.replace(/\x00/g, '');
  const trimmed = sanitized.trim();
  if (trimmed.length === 0) throw new Error('原文为空：请提供评论区 / 商家页的抄录文本');
  if (trimmed.length < SOURCE_TEXT_MIN) {
    throw new Error(`原文太短（${trimmed.length} 字符，至少 ${SOURCE_TEXT_MIN}）：信息量不足以归纳摘要`);
  }
  const clipped = clipSourceText(trimmed);

  const existing = await repo.getResearch(productId);
  if (existing && !opts.force) {
    throw new Error(`${opts.externalId} 已有一份调研摘要（${existing.createdAt.slice(0, 10)} 生成）；重做加 --force`);
  }

  if (!opts.agent) {
    throw new Error('未配置 OPENAI_API_KEY——调研摘要需要 LLM；或人工整理后直接用于内容创作');
  }

  // —— 预算熔断（与 daily-scan 同一条预算；env 乱值兜底默认 50）——
  const raw = opts.llmBudgetPerDay ?? Number(process.env.GWD_LLM_BUDGET_CALLS_PER_DAY ?? 50);
  const budget = Number.isFinite(raw) ? raw : 50;
  const used = await repo.countLlmCallsToday();
  if (used >= budget) {
    throw new Error(`LLM 日预算已用尽（${used}/${budget}）：明天再跑，或人工整理`);
  }

  // runId：当日 run（历史品无当日 run 时为 null，审计照落）
  const todayRun = await repo.getLatestRun(todayShanghai());
  const runId = todayRun?.id ?? null;

  // 品基础字段（给 Agent 判断上下文；优先当日快照，历史品退化为 externalId）
  const snapshots = await repo.getSnapshotsByDate(todayShanghai());
  const snap = snapshots.find((s) => s.productId === productId) ?? null;
  const product = {
    externalId: opts.externalId,
    title: snap?.title ?? opts.externalId,
    category: snap?.category ?? null,
    price: snap?.price ?? null,
    commissionRate: snap?.commissionRate ?? null,
    sales30d: snap?.sales30d ?? null,
  };

  const startedAt = Date.now();
  let logged = false; // 审计单条化：落库故障时不重复记失败（一次调用最多一条审计）
  try {
    const r = await opts.agent.summarize({ product, sourceText: clipped });
    if (r.degraded) {
      throw new Error('LLM 未按要求提交摘要（步数用尽或结构异常）');
    }
    // 服务层兜底校验（agent 输出不可信：畸形/注水 summary 拒绝落库，与打档 validateSuggestions 同防线）
    const checked = ResearchSummarySchema.safeParse(r.summary);
    if (!checked.success) {
      throw new Error('LLM 摘要未过服务层校验（结构畸形或条目越界），已拒绝落库');
    }
    await repo.saveLlmLog({
      runId: runId ?? undefined,
      purpose: 'research:summary',
      model: r.audit.model,
      skill: r.audit.skill,
      input: r.audit.input,
      output: r.audit.output,
      ok: true,
      latencyMs: Date.now() - startedAt,
    });
    logged = true;
    await repo.saveResearch({ productId, sourceText: clipped, summary: checked.data, runId });
    return {
      externalId: opts.externalId,
      productId,
      summary: checked.data,
      sourceTextChars: clipped.length,
      truncated: clipped.length < trimmed.length,
    };
  } catch (e) {
    if (!logged) {
      await repo.saveLlmLog({
        runId: runId ?? undefined,
        purpose: 'research:summary',
        model: opts.agent.name,
        skill: 'research',
        input: { error: 'agent-threw', externalId: opts.externalId },
        ok: false,
        error: String(e),
        latencyMs: Date.now() - startedAt,
      });
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** 查看已有摘要（CLI 无 --file 时） */
export async function showResearch(repo: Repo, externalId: string): Promise<ResearchRow | null> {
  const productId = await repo.findProductIdByExternalId(externalId);
  if (productId == null) throw new Error(`没有找到商品 ${externalId}（先 import-candidates）`);
  return repo.getResearch(productId);
}
