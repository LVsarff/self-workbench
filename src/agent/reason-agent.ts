/**
 * 单 Agent 运行时（MVP：daily-scan 理由生成）。
 * 对应《AI带货工作台-单Agent最小方案》§2 Prompt 分层 / §3 五层停止条件。
 * - 骨架 Prompt + Skill 任务包从文件加载（可独立迭代）
 * - 工具循环：save_reason ×N → submit_list；maxSteps 硬限（运行时停止条件第 2 层）
 * - 「完成」做成工具：submit_list 即提交即结束（第 1 层）
 * - 未提交 / 理由缺失 / 异常 → 由流水线降级为模板理由（有价值的降级）
 * - 无状态：run 间不共享记忆，跨 run 的东西当场落库
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { ruleSummary, type RuleConfig } from '../core/rule-config.js';
import type { ScoredProduct, SimilarProduct } from '../core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKELETON = readFileSync(join(HERE, 'prompts', 'skeleton.md'), 'utf8');
export const SKILL_DAILY_SCAN = readFileSync(join(HERE, 'skills', 'daily-scan', 'SKILL.md'), 'utf8');
export const SKILL_VERSION = 'daily-scan@1';

export interface ReasonRequest {
  runId: string;
  top: ScoredProduct[];
  rule: RuleConfig;
  history: SimilarProduct[];
}

export interface ReasonAgentResult {
  reasons: Array<{ productId: string; text: string; citedFields: string[] }>;
  submitted: boolean;
  /** 是否触发了停止条件保护（步数用尽 / 未提交 / 校验失败被丢弃） */
  degraded: boolean;
  audit: {
    purpose: string;
    model: string;
    skill: string;
    input: unknown;
    output: unknown;
  };
}

export interface ReasonAgent {
  name: string;
  generate(req: ReasonRequest): Promise<ReasonAgentResult>;
}

/**
 * 商家可控文本截断（对抗测试 P2 修复）：
 * 标题/类目来自选品广场，可能被塞超长垃圾或注入载荷——进 prompt 前截断，截断处显式标记。
 */
function clipText(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`;
}

const TITLE_MAX = 120;
const CATEGORY_MAX = 40;

/** Top 候选 → 注入上下文的快照（查询结果进上下文，不是原始库） */
function topToInput(p: ScoredProduct) {
  const s = p.snapshot;
  return {
    product_id: p.productId,
    external_id: s.externalId,
    title: clipText(s.title, TITLE_MAX),
    category: clipText(s.category, CATEGORY_MAX),
    price: s.price,
    commission_rate: s.commissionRate,
    sales_30d: s.sales30d,
    mom_trend: s.momTrend,
    review_rate: s.reviewRate,
    return_rate: s.returnRate,
    merchant_score: s.merchantScore,
    dimension_scores: p.scores,
    total: p.total,
    grade: p.grade,
    flags: p.flags,
  };
}

export function buildAgentPrompt(req: ReasonRequest): { system: string; prompt: string } {
  const system = `${SKELETON}\n\n# 当前任务包\n${SKILL_DAILY_SCAN}`;
  const prompt = [
    '## 今日输入 [DATA]',
    `run_id: ${req.runId}`,
    '',
    '### 规则摘要（当前版本）',
    ruleSummary(req.rule),
    '',
    '### 历史相似品（此前已勾选过的同类目品，可能为空）',
    req.history.length === 0 ? '无' : JSON.stringify(req.history),
    '',
    `### Top${req.top.length} 候选品`,
    '```json',
    JSON.stringify(req.top.map(topToInput), null, 2),
    '```',
    '',
    '请按任务包流程执行：逐个调用 save_reason，全部完成后调用 submit_list。',
  ].join('\n');
  return { system, prompt };
}

const ReasonArgsSchema = z.object({
  product_id: z.string(),
  text: z.string().min(20).max(300),
  cited_fields: z.array(z.string()).min(1),
});

/**
 * cited_fields 白名单（对抗测试 P3 修复）：
 * 理由引用的字段名必须真实存在于注入上下文（topToInput 的键集），
 * 伪造字段名被过滤；全部非法 → 整条理由丢弃（防幻觉锚点）。
 */
const ALLOWED_CITED_FIELDS = new Set([
  'product_id', 'external_id', 'title', 'category', 'price',
  'commission_rate', 'sales_30d', 'mom_trend', 'review_rate', 'return_rate',
  'merchant_score', 'dimension_scores', 'total', 'grade', 'flags',
]);

/** 校验收集到的理由（引用必须来自 Top 候选，长度合规，字段名净化） */
export function validateCollectedReasons(
  collected: Array<{ productId: string; text: string; citedFields: string[] }>,
  top: ScoredProduct[],
): Array<{ productId: string; text: string; citedFields: string[] }> {
  const validIds = new Set(top.map((p) => p.productId));
  const out: Array<{ productId: string; text: string; citedFields: string[] }> = [];
  for (const r of collected) {
    if (!validIds.has(r.productId) || r.text.length < 20 || r.text.length > 300) continue;
    const cited = r.citedFields.filter((f) => ALLOWED_CITED_FIELDS.has(f));
    if (cited.length === 0) continue; // 全部是伪造字段名 → 丢弃
    out.push({ ...r, citedFields: cited });
  }
  return out;
}

/**
 * AI SDK 实现（generateText + 工具循环 + stopWhen: stepCountIs 硬限）。
 * 模型通过参数注入（测试可传 MockLanguageModelV4）。
 */
export function createAiSdkReasonAgent(opts: {
  model: LanguageModel;
  modelName: string;
  maxSteps?: number;
}): ReasonAgent {
  const maxSteps = opts.maxSteps ?? 8;
  return {
    name: `ai-sdk:${opts.modelName}`,
    async generate(req: ReasonRequest): Promise<ReasonAgentResult> {
      const { system, prompt } = buildAgentPrompt(req);

      // 运行态：只在本次 run 内有效，结束即弃（上下文不是存储）
      const collected: Array<{ productId: string; text: string; citedFields: string[] }> = [];
      let submitted = false;

      const saveReason = tool({
        description: '保存一个候选品的推荐理由（80-120 字，引用真实字段值）',
        inputSchema: ReasonArgsSchema,
        execute: async (args) => {
          collected.push({ productId: args.product_id, text: args.text, citedFields: args.cited_fields });
          return { ok: true, saved: collected.length };
        },
      });

      const submitList = tool({
        description: '提交今日清单，任务结束',
        inputSchema: z.object({ run_id: z.string() }),
        execute: async (args) => {
          if (args.run_id === req.runId) {
            submitted = true;
            return { ok: true, submitted: true };
          }
          return { ok: false, error: 'run_id 不匹配' };
        },
      });

      const result = await generateText({
        model: opts.model,
        instructions: system,
        prompt,
        tools: { save_reason: saveReason, submit_list: submitList },
        // 停止条件第 2 层：步数硬限（运行时强制，prompt 说什么都拦得住）
        stopWhen: stepCountIs(maxSteps),
      });

      const reasons = validateCollectedReasons(collected, req.top);
      const degraded = !submitted || reasons.length < req.top.length;

      return {
        reasons,
        submitted,
        degraded,
        audit: {
          purpose: 'daily-scan:reasons',
          model: opts.modelName,
          skill: SKILL_VERSION,
          input: { system, prompt },
          output: {
            steps: result.steps.length,
            toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
            finishReason: result.finishReason,
            collected: collected.length,
            valid: reasons.length,
            submitted,
          },
        },
      };
    },
  };
}

/** 从环境变量构造 OpenAI Agent；无 key 返回 null（流水线自动降级模板理由） */
export function createReasonAgentFromEnv(): ReasonAgent | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const modelName = process.env.GWD_LLM_MODEL ?? 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey });
  return createAiSdkReasonAgent({ model: openai(modelName), modelName });
}

/** 脚本化 Agent：测试与 `gwd demo` 用（走同样的校验路径，source 仍记 llm） */
export function createScriptedReasonAgent(): ReasonAgent {
  return {
    name: 'scripted',
    async generate(req: ReasonRequest): Promise<ReasonAgentResult> {
      const collected = req.top.map((p) => {
        const s = p.snapshot;
        const text = [
          `佣金 ${s.commissionRate ?? '数据缺失'}%，近30天销量 ${s.sales30d ?? '数据缺失'}${s.momTrend === 'up' ? '且环比上升' : ''}，好评率 ${s.reviewRate ?? '数据缺失'}%；`,
          `总分 ${p.total}，${p.grade === 'strong' ? '各维度均衡偏强' : '存在短板'}（内容友好度得分 ${p.scores.contentFriendliness ?? '待评'}，竞争度得分 ${p.scores.competition ?? '待评'}）`,
          req.history.length > 0 ? `；与历史品 ${req.history[0]!.externalId} 同类目可对比` : '',
        ].join('');
        return {
          productId: p.productId,
          text,
          citedFields: ['commission_rate', 'sales_30d', 'review_rate', 'total'],
        };
      });
      const reasons = validateCollectedReasons(collected, req.top);
      return {
        reasons,
        submitted: true,
        degraded: reasons.length < req.top.length,
        audit: {
          purpose: 'daily-scan:reasons',
          model: 'scripted',
          skill: SKILL_VERSION,
          input: { top: req.top.map((p) => p.snapshot.externalId) },
          output: { collected: collected.length, valid: reasons.length, submitted: true },
        },
      };
    },
  };
}
