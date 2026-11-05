/**
 * 内容审查器（L2 概率层，模块② B1）：《场景拆解》2.1 #11 自检的 LLM 半边。
 * 与生成同一运行时模式（骨架 Prompt + 任务包 + 工具提交 + 步数硬限），换装 content-review。
 *
 * 语义边界（与 L1 词表的区别，务必分清）：
 * - L1 命中 = 硬语义：触发修订循环，修不掉 → needs_manual，门③ 拒绝确认
 * - L2 结论 = 仅提示：pass=false 时草稿仍是 draft，review 字段落库，
 *   由门③ 人工在 5 项清单第 2 项里终判——审查器不拦截任何内容
 * - temperature 0：审查要一致性，不要创意（生成 0.7 / 理由默认 / 审查 0）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { ContentProductInput } from './content-agent.js';
import { SKELETON } from './reason-agent.js';
import type { ContentRisk, DouyinScript, Platform, XiaohongshuNote } from '../core/types.js';
import { PLATFORM_LABEL } from '../core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_CONTENT_REVIEW = readFileSync(join(HERE, 'skills', 'content-review', 'SKILL.md'), 'utf8');
export const CONTENT_REVIEW_SKILL_VERSION = 'content-review@1';

export interface ContentReviewRequest {
  platform: Platform;
  content: XiaohongshuNote | DouyinScript;
  product: ContentProductInput;
}

export interface ContentReviewResult {
  pass: boolean;
  risks: ContentRisk[];
}

export interface ContentReviewer {
  name: string;
  review(req: ContentReviewRequest): Promise<ContentReviewResult>;
}

/** 审查结论 schema（submit_review 入参，与《content-review 任务包》输出契约一致） */
export const ReviewConclusionSchema = z.object({
  pass: z.boolean(),
  risks: z
    .array(
      z.object({
        type: z.enum(['absolute', 'medical', 'exaggeration', 'fabricated_data', 'other']),
        detail: z.string().min(1).max(200),
      }),
    )
    .max(10),
});

/** 商家可控文本截断（与 content-agent 同策略） */
function clipText(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`;
}

const TITLE_MAX = 120;
const CATEGORY_MAX = 40;

export function buildReviewPrompt(req: ContentReviewRequest): { system: string; prompt: string } {
  const system = `${SKELETON}\n\n# 当前任务包\n${SKILL_CONTENT_REVIEW}`;
  const p = req.product;
  const prompt = [
    '## 输入 [DATA]',
    '',
    '### 商品字段（事实基准，文中数字只能来自这里）',
    '```json',
    JSON.stringify(
      {
        external_id: p.externalId,
        title: clipText(p.title, TITLE_MAX),
        category: clipText(p.category, CATEGORY_MAX),
        price: p.price,
        sales_30d: p.sales30d,
        review_rate: p.reviewRate,
      },
      null,
      2,
    ),
    '```',
    '',
    `### 待审查草稿（${PLATFORM_LABEL[req.platform]}）`,
    '```json',
    JSON.stringify(req.content, null, 2),
    '```',
    '',
    '请按任务包逐维度审查，调用 submit_review 提交结论。',
  ].join('\n');
  return { system, prompt };
}

/** AI SDK 实现（单工具提交 + 步数硬限；未提交 = 抛错，由流水线降级为「审查跳过」） */
export function createAiSdkContentReviewer(opts: {
  model: LanguageModel;
  modelName: string;
  maxSteps?: number;
}): ContentReviewer {
  const maxSteps = opts.maxSteps ?? 3;
  return {
    name: `ai-sdk:${opts.modelName}`,
    async review(req: ContentReviewRequest): Promise<ContentReviewResult> {
      const { system, prompt } = buildReviewPrompt(req);
      const captured: ContentReviewResult[] = [];

      const submitReview = tool({
        description: '提交审查结论，任务结束',
        inputSchema: ReviewConclusionSchema,
        execute: async (args) => {
          captured.push({ pass: args.pass, risks: args.risks });
          return { ok: true };
        },
      });

      await generateText({
        model: opts.model,
        instructions: system,
        prompt,
        tools: { submit_review: submitReview },
        temperature: 0,
        stopWhen: stepCountIs(maxSteps),
      });

      const out = captured[captured.length - 1];
      if (!out) throw new Error('审查未提交结论（步数用尽或未调用 submit_review）');
      return out;
    },
  };
}

/** 从环境变量构造；无 key 返回 null（流水线跳过 L2，仅 L1 词表） */
export function createContentReviewerFromEnv(): ContentReviewer | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const modelName = process.env.GWD_LLM_MODEL ?? 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
  return createAiSdkContentReviewer({ model: openai(modelName), modelName });
}

/** 脚本化审查器：测试与 `gwd demo` 用（脚本化内容构造上合规） */
export function createScriptedContentReviewer(): ContentReviewer {
  return {
    name: 'scripted-review',
    async review(): Promise<ContentReviewResult> {
      return { pass: true, risks: [] };
    },
  };
}
