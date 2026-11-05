/**
 * 打档建议 Agent（模块① V2 可选增强：主观三维辅助打档）。
 * 与 content-reviewer 同运行时模式（骨架 Prompt + 任务包 + 单工具提交 + 步数硬限）。
 *
 * 语义边界（务必分清）：
 * - 建议不落库、不改分——打档的唯一事实源是人工填的候选 CSV（保持审计链）
 * - 人可改：AI 给档位建议 + 依据，终判是人
 * - LLM 调用本身由流水线记入 llm_call_logs 审计表
 * - temperature 0：打档要一致性，不要创意
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { SKELETON } from './reason-agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_GRADE_SUGGEST = readFileSync(join(HERE, 'skills', 'grade-suggest', 'SKILL.md'), 'utf8');
export const GRADE_SUGGEST_SKILL_VERSION = 'grade-suggest@1';

/** 待评品输入字段（判断只能基于这些；三维缺失本身就是要补的东西，不在输入里） */
export interface GradeProductInput {
  externalId: string;
  title: string;
  category: string | null;
  price: number | null;
  commissionRate: number | null;
  sales30d: number | null;
  momTrend: string | null;
  reviewRate: number | null;
}

/** 单品建议：三维档位（1-5）+ 依据 + 引用字段 */
export interface GradeSuggestion {
  externalId: string;
  contentFriendliness: number;
  competition: number;
  repurchase: number;
  rationale: string;
  citedFields: string[];
}

export interface GradeSuggestRequest {
  runId: string;
  products: GradeProductInput[];
}

export interface GradeAgentResult {
  suggestions: GradeSuggestion[];
  /** 请求了但未完整产出（失败 / 步数用尽 / 部分缺失 / 校验丢弃） */
  degraded: boolean;
  audit: {
    purpose: string;
    model: string;
    skill: string;
    input: unknown;
    output: unknown;
  };
}

export interface GradeAgent {
  name: string;
  suggest(req: GradeSuggestRequest): Promise<GradeAgentResult>;
}

/** 商家可控文本截断（与 content-agent / reason-agent 同策略） */
function clipText(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`;
}

const TITLE_MAX = 120;
const CATEGORY_MAX = 40;

const GradeBandSchema = z.number().int().min(1).max(5);

/** submit_grades 入参 schema（与任务包输出契约一致） */
export const SubmitGradesSchema = z.object({
  grades: z
    .array(
      z.object({
        external_id: z.string(),
        content_friendliness: GradeBandSchema,
        competition: GradeBandSchema,
        repurchase: GradeBandSchema,
        rationale: z.string().min(10).max(200),
        cited_fields: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(20),
});

export function buildGradePrompt(req: GradeSuggestRequest): { system: string; prompt: string } {
  const system = `${SKELETON}\n\n# 当前任务包\n${SKILL_GRADE_SUGGEST}`;
  const prompt = [
    '## 今日输入 [DATA]',
    `run_id: ${req.runId}`,
    '',
    `### 待评品（${req.products.length} 个，门槛已过、主观三维缺失）`,
    '```json',
    JSON.stringify(
      req.products.map((p) => ({
        external_id: p.externalId,
        title: clipText(p.title, TITLE_MAX),
        category: clipText(p.category, CATEGORY_MAX),
        price: p.price,
        commission_rate: p.commissionRate,
        sales_30d: p.sales30d,
        mom_trend: p.momTrend,
        review_rate: p.reviewRate,
      })),
      null,
      2,
    ),
    '```',
    '',
    '请按任务包流程执行：逐品判断三维档位，调用 submit_grades 一次性提交全部建议。',
  ].join('\n');
  return { system, prompt };
}

/** 引用字段白名单：必须真实存在于注入上下文（防幻觉锚点，与 reason-agent 同策略） */
const ALLOWED_CITED_FIELDS = new Set([
  'external_id', 'title', 'category', 'price',
  'commission_rate', 'sales_30d', 'mom_trend', 'review_rate',
]);

/** 校验提交的建议：externalId 白名单 + 引用字段净化（全部伪造 → 丢弃该条） */
export function validateSuggestions(
  collected: GradeSuggestion[],
  products: GradeProductInput[],
): GradeSuggestion[] {
  const validIds = new Set(products.map((p) => p.externalId));
  const out: GradeSuggestion[] = [];
  for (const s of collected) {
    if (!validIds.has(s.externalId)) continue;
    const cited = s.citedFields.filter((f) => ALLOWED_CITED_FIELDS.has(f));
    if (cited.length === 0) continue;
    out.push({ ...s, citedFields: cited });
  }
  return out;
}

/** AI SDK 实现（单工具提交 + 步数硬限；未提交 = degraded，由流水线提示人工打档） */
export function createAiSdkGradeAgent(opts: {
  model: LanguageModel;
  modelName: string;
  maxSteps?: number;
}): GradeAgent {
  const maxSteps = opts.maxSteps ?? 3;
  return {
    name: `ai-sdk:${opts.modelName}`,
    async suggest(req: GradeSuggestRequest): Promise<GradeAgentResult> {
      const { system, prompt } = buildGradePrompt(req);
      const captured: GradeSuggestion[] = [];

      const submitGrades = tool({
        description: '一次性提交全部待评品的三维打档建议',
        inputSchema: SubmitGradesSchema,
        execute: async (args) => {
          for (const g of args.grades) {
            captured.push({
              externalId: g.external_id,
              contentFriendliness: g.content_friendliness,
              competition: g.competition,
              repurchase: g.repurchase,
              rationale: g.rationale,
              citedFields: g.cited_fields,
            });
          }
          return { ok: true, count: captured.length };
        },
      });

      const result = await generateText({
        model: opts.model,
        instructions: system,
        prompt,
        tools: { submit_grades: submitGrades },
        temperature: 0,
        stopWhen: stepCountIs(maxSteps),
      });

      const suggestions = validateSuggestions(captured, req.products);
      const submitted = captured.length > 0;
      return {
        suggestions,
        degraded: !submitted || suggestions.length < req.products.length,
        audit: {
          purpose: 'grade-suggest:grades',
          model: opts.modelName,
          skill: GRADE_SUGGEST_SKILL_VERSION,
          input: { system, prompt },
          output: {
            steps: result.steps.length,
            toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
            finishReason: result.finishReason,
            collected: captured.length,
            valid: suggestions.length,
          },
        },
      };
    },
  };
}

/** 从环境变量构造；无 key 返回 null（CLI 提示人工打档，不阻塞选品） */
export function createGradeAgentFromEnv(): GradeAgent | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const modelName = process.env.GWD_LLM_MODEL ?? 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
  return createAiSdkGradeAgent({ model: openai(modelName), modelName });
}

/**
 * 脚本化 Agent：测试与 `gwd demo` 用（走同样的校验路径）。
 * 确定性映射：类目先验 + 商业信号锚点——演示「建议长什么样」，不是真智能。
 */
export function createScriptedGradeAgent(): GradeAgent {
  return {
    name: 'scripted-grade',
    async suggest(req: GradeSuggestRequest): Promise<GradeAgentResult> {
      const collected = req.products.map((p) => {
        const category = p.category ?? '';
        // 内容友好度：类目先验（易展示的类目给高档）
        const easyCategories = ['家居', '收纳', '厨房', '美妆', '个护', '数码配件', '母婴'];
        const cf = easyCategories.some((c) => category.includes(c)) ? 5 : category === '' ? 3 : 4;
        // 竞争缓和度：高佣金 + 高销量并存的类目往往已卷（25%/3200 → 3；低销量蓝海 → 4）
        const comp =
          (p.commissionRate ?? 0) >= 20 && (p.sales30d ?? 0) >= 2000 ? 3 : (p.sales30d ?? 0) >= 5000 ? 2 : 4;
        // 复购扩展：无类目先验时给中位
        const rp = category.includes('家居') || category.includes('收纳') ? 4 : 3;
        const rationale = `${category || '类目未知'}类目${category ? '视觉展示与场景丰富，易出内容' : '信息不足，按中位建议'}；佣金 ${p.commissionRate ?? '-'}%、近30天销量 ${p.sales30d ?? '-'}（竞争${comp >= 4 ? '较缓和' : '较激烈'}）；复购与延展按类目先验给 ${rp} 档`;
        return {
          externalId: p.externalId,
          contentFriendliness: cf,
          competition: comp,
          repurchase: rp,
          rationale,
          citedFields: ['category', 'commission_rate', 'sales_30d'],
        };
      });
      const suggestions = validateSuggestions(collected, req.products);
      return {
        suggestions,
        degraded: suggestions.length < req.products.length,
        audit: {
          purpose: 'grade-suggest:grades',
          model: 'scripted',
          skill: GRADE_SUGGEST_SKILL_VERSION,
          input: { products: req.products.map((p) => p.externalId) },
          output: { collected: collected.length, valid: suggestions.length },
        },
      };
    },
  };
}
