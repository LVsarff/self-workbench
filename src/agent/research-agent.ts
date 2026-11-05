/**
 * 深度调研摘要 Agent（模块① V2 收官：评论区舆情 / 商家资质摘要，人终判）。
 * 与 grade-agent / content-reviewer 同运行时模式（骨架 Prompt + 任务包 + 单工具提交 + 步数硬限）。
 *
 * 语义边界：
 * - 摘要是参考不是事实——最终判断在人（选品决策 / 内容取材均人拍板）
 * - 原文是人工抄录（商家可控文本）：进 prompt 前截断（SOURCE_TEXT_MAX），注入防护同既有策略
 * - LLM 调用由流水线记入 llm_call_logs 审计表
 * - temperature 0：归纳要一致性，不要创意
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { SKELETON } from './reason-agent.js';
import { fenceContent } from '../core/prompt-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_RESEARCH = readFileSync(join(HERE, 'skills', 'research', 'SKILL.md'), 'utf8');
export const RESEARCH_SKILL_VERSION = 'research@1';

/** 原文进 prompt / 存档的上限（约 8K 字符；超出截断，审计留痕标记） */
export const SOURCE_TEXT_MAX = 8000;

export interface ResearchProductContext {
  externalId: string;
  title: string;
  category: string | null;
  price: number | null;
  commissionRate: number | null;
  sales30d: number | null;
}

export interface ResearchSummaryResult {
  summary: {
    sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
    highlights: string[];
    risks: string[];
    materialPoints: string[];
  };
  /** 未提交 / 提交但结构异常 → 降级（流水线提示人工整理） */
  degraded: boolean;
  audit: {
    purpose: string;
    model: string;
    skill: string;
    input: unknown;
    output: unknown;
  };
}

export interface ResearchAgent {
  name: string;
  summarize(req: { product: ResearchProductContext; sourceText: string }): Promise<ResearchSummaryResult>;
}

/** submit_research 入参 schema（与任务包输出契约一致） */
export const SubmitResearchSchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
  highlights: z.array(z.string().min(4).max(120)).min(1).max(5),
  risks: z.array(z.string().min(4).max(120)).max(5),
  material_points: z.array(z.string().min(4).max(120)).min(1).max(5),
});

/** 服务层兜底校验（camelCase，与 SubmitResearchSchema 同约束）：agent 输出不可信，落库前必须过一遍 */
export const ResearchSummarySchema = z.object({
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
  highlights: z.array(z.string().min(4).max(120)).min(1).max(5),
  risks: z.array(z.string().min(4).max(120)).max(5),
  materialPoints: z.array(z.string().min(4).max(120)).min(1).max(5),
});

/** 原文截断（标记算进预算，与 note 截断同策略） */
export function clipSourceText(text: string): string {
  const mark = '…[截断]';
  return text.length <= SOURCE_TEXT_MAX ? text : `${text.slice(0, SOURCE_TEXT_MAX - mark.length)}${mark}`;
}

/**
 * 原文包裹（P2 修复 #4 统一到 core/prompt-guard，此处保留同名导出兼容既有测试）：
 * 围栏逃逸安全——含 ``` 时改 4 空格缩进块。
 */
export const wrapSourceText = fenceContent;

export function buildResearchPrompt(req: { product: ResearchProductContext; sourceText: string }): { system: string; prompt: string } {
  const system = `${SKELETON}\n\n# 当前任务包\n${SKILL_RESEARCH}`;
  const prompt = [
    '## 品基础字段 [PRODUCT]',
    '```json',
    JSON.stringify(
      {
        external_id: req.product.externalId,
        title: req.product.title.slice(0, 120),
        category: req.product.category?.slice(0, 40) ?? null,
        price: req.product.price,
        commission_rate: req.product.commissionRate,
        sales_30d: req.product.sales30d,
      },
      null,
      2,
    ),
    '```',
    '',
    '## 人工抄录原文 [SOURCE_TEXT]',
    wrapSourceText(clipSourceText(req.sourceText)),
    '',
    '请按任务包流程执行：归纳舆情要点 / 风险信号 / 可用素材点，调用 submit_research 一次性提交。',
  ].join('\n');
  return { system, prompt };
}

/** AI SDK 实现（单工具提交 + 步数硬限） */
export function createAiSdkResearchAgent(opts: {
  model: LanguageModel;
  modelName: string;
  maxSteps?: number;
}): ResearchAgent {
  const maxSteps = opts.maxSteps ?? 3;
  return {
    name: `ai-sdk:${opts.modelName}`,
    async summarize(req) {
      const { system, prompt } = buildResearchPrompt(req);
      // 对象包装：闭包内赋值 + 外部读取时，TS 控制流会把 let 变量窄化为 null（never），
      // 属性类型则保持声明类型
      const box: { value: z.infer<typeof SubmitResearchSchema> | null } = { value: null };

      const submitResearch = tool({
        description: '一次性提交调研摘要（舆情要点 / 风险信号 / 可用素材点）',
        inputSchema: SubmitResearchSchema,
        execute: async (args) => {
          box.value = args;
          return { ok: true };
        },
      });

      const result = await generateText({
        model: opts.model,
        instructions: system,
        prompt,
        tools: { submit_research: submitResearch },
        temperature: 0,
        stopWhen: stepCountIs(maxSteps),
      });

      const c = box.value;
      const submitted = c !== null;
      const summary = c
        ? {
            sentiment: c.sentiment,
            highlights: c.highlights,
            risks: c.risks,
            materialPoints: c.material_points,
          }
        : { sentiment: 'neutral' as const, highlights: [], risks: [], materialPoints: [] };
      return {
        summary,
        degraded: !submitted,
        audit: {
          purpose: 'research:summary',
          model: opts.modelName,
          skill: RESEARCH_SKILL_VERSION,
          input: { system, prompt },
          output: {
            steps: result.steps.length,
            toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
            finishReason: result.finishReason,
            submitted,
          },
        },
      };
    },
  };
}

/** 从环境变量构造；无 key 返回 null（流水线提示人工整理，不阻塞） */
export function createResearchAgentFromEnv(): ResearchAgent | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const modelName = process.env.GWD_LLM_MODEL ?? 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
  return createAiSdkResearchAgent({ model: openai(modelName), modelName });
}

/**
 * 脚本化 Agent：测试与 `gwd demo` 用（走同样的 schema 契约）。
 * 确定性关键词规则——演示「摘要长什么样」，不是真智能。
 */
const POSITIVE_WORDS = ['好用', '喜欢', '回购', '推荐', '满意', '划算', '方便', '清爽', '简单', '好看'];
const RISK_WORDS = ['差评', '退货', '假货', '过敏', '失望', '破损', '松动', '发货慢', '漏发', '退款', '变质'];
const CONCERN_MARKS = ['？', '?', '吗', '怎么', '多久', '能不能'];

export function createScriptedResearchAgent(): ResearchAgent {
  return {
    name: 'scripted-research',
    async summarize(req) {
      const text = clipSourceText(req.sourceText);
      const sentences = text
        .split(/[\n。！!？?；;]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4);

      const highlights: string[] = [];
      const risks: string[] = [];
      const materialPoints: string[] = [];
      for (const s of sentences) {
        if (RISK_WORDS.some((w) => s.includes(w))) {
          if (risks.length < 5) risks.push(s.slice(0, 120));
        } else if (POSITIVE_WORDS.some((w) => s.includes(w))) {
          if (highlights.length < 5) highlights.push(s.slice(0, 120));
        } else if (CONCERN_MARKS.some((m) => s.includes(m))) {
          if (materialPoints.length < 5) materialPoints.push(s.slice(0, 120));
        } else if (materialPoints.length < 5 && s.length >= 8) {
          materialPoints.push(s.slice(0, 120));
        }
      }
      if (highlights.length === 0) highlights.push('原文正面反馈样本不足，建议补充评论区样本');
      if (materialPoints.length === 0) materialPoints.push('原文信息量不足，建议补充评论区样本');

      const sentiment = risks.length > highlights.length ? 'negative' : risks.length === 0 ? 'positive' : 'mixed';
      const summary = { sentiment, highlights, risks, materialPoints } as const;
      return {
        summary,
        degraded: false,
        audit: {
          purpose: 'research:summary',
          model: 'scripted',
          skill: RESEARCH_SKILL_VERSION,
          input: { externalId: req.product.externalId, sourceLength: text.length },
          output: { sentiment, highlights: highlights.length, risks: risks.length, materialPoints: materialPoints.length },
        },
      };
    },
  };
}
