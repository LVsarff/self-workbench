/**
 * 内容 Agent（模块② 内容工坊 B1 首项：双平台草稿生成）。
 * 与 reason-agent 同一运行时模式：骨架 Prompt + Skill 任务包 + 工具提交 + 步数硬限。
 * 差异点：
 * - 一次调用产两版：save_xiaohongshu + save_douyin → submit_content（卖点天然一致，token 减半）
 * - temperature 0.7：内容需要创意（理由生成走默认温度保严谨）
 * - 降级语义不同：内容不降级到模板文案（批量模板 = 合规风险），
 *   由流水线标记 needs_manual 交人重写（《单Agent最小方案》§3 内容 run 超限降级）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { DouyinScript, Platform, XiaohongshuNote } from '../core/types.js';
import { PLATFORM_LABEL } from '../core/types.js';
import { SKELETON } from './reason-agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_CONTENT_GEN = readFileSync(join(HERE, 'skills', 'content-gen', 'SKILL.md'), 'utf8');
export const CONTENT_SKILL_VERSION = 'content-gen@1';

/** 商家可控文本截断（与 reason-agent 同策略：进 prompt 前截断并标记） */
function clipText(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`;
}

const TITLE_MAX = 120;
const CATEGORY_MAX = 40;

/** 注入上下文的商品快照（佣金/总分/等级是内部决策数据，不进内容输入，模型无从泄露） */
export interface ContentProductInput {
  productId: string;
  externalId: string;
  title: string;
  category: string | null;
  price: number | null;
  sales30d: number | null;
  momTrend: string | null;
  reviewRate: number | null;
  /** 选品理由（系统此前生成，仅作卖点参考） */
  reason: string | null;
}

/** 近期已确认内容（历史参考：避免重复标题与角度） */
export interface ContentReference {
  platform: Platform;
  batchDate: string;
  /** 展示标题（小红书标题 / 抖音钩子） */
  title: string;
}

/** 修订任务（生成-自检-修订循环，≤2 轮）：只重做列出的平台 */
export interface ContentRevisionTask {
  platform: Platform;
  /** 系统检查出的具体问题（词表命中 / 结构不合规 / 与历史相似） */
  issues: string[];
  /** 之前版本（缺失产出时为 null） */
  previous: XiaohongshuNote | DouyinScript | null;
}

export interface ContentRequest {
  runId: string;
  product: ContentProductInput;
  /** 近期已确认内容（历史参考，可空） */
  references?: ContentReference[] | null;
  /** 深度调研摘要（模块① V2：买家真实关注点 = 素材，可空） */
  research?: ContentResearchContext | null;
  /** 非空 = 修订模式 */
  revision?: ContentRevisionTask[] | null;
}

/** 调研摘要注入上下文（来自 product_research，人终判的参考） */
export interface ContentResearchContext {
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  highlights: string[];
  risks: string[];
  materialPoints: string[];
}

export interface ContentAgentResult {
  xiaohongshu: XiaohongshuNote | null;
  douyin: DouyinScript | null;
  submitted: boolean;
  /** 未提交 / 任一平台缺失 */
  degraded: boolean;
  audit: {
    purpose: string;
    model: string;
    skill: string;
    input: { prompt: string };
    output: unknown;
  };
}

export interface ContentAgent {
  name: string;
  generate(req: ContentRequest): Promise<ContentAgentResult>;
}

/** 草稿结构校验（工具入参和流水线兜底共用一份口径） */
export const XiaohongshuNoteSchema = z.object({
  title: z.string().min(5).max(20),
  body: z.string().min(150).max(500),
  tags: z.array(z.string().min(1).max(20)).min(3).max(8),
  coverIdea: z.string().max(50).nullable(),
});

export const DouyinScriptSchema = z.object({
  hook: z.string().min(5).max(30),
  points: z.array(z.string().min(5).max(100)).min(2).max(4),
  cta: z.string().min(5).max(50),
});

export function buildContentPrompt(req: ContentRequest): { system: string; prompt: string } {
  const system = `${SKELETON}\n\n# 当前任务包\n${SKILL_CONTENT_GEN}`;
  const p = req.product;
  const sections: string[] = [
    '## 输入 [DATA]',
    `run_id: ${req.runId}`,
    '',
    '### 已勾选商品（人已拍板要做内容）',
    '```json',
    JSON.stringify(
      {
        product_id: p.productId,
        external_id: p.externalId,
        title: clipText(p.title, TITLE_MAX),
        category: clipText(p.category, CATEGORY_MAX),
        price: p.price,
        sales_30d: p.sales30d,
        mom_trend: p.momTrend,
        review_rate: p.reviewRate,
        selection_reason: p.reason,
      },
      null,
      2,
    ),
    '```',
  ];

  const refs = req.references ?? [];
  if (refs.length > 0) {
    sections.push('', '### 近期已确认内容（参考：避免重复标题与角度）');
    for (const r of refs) {
      sections.push(`- [${PLATFORM_LABEL[r.platform]}][${r.batchDate}] ${clipText(r.title, 30)}`);
    }
  }

  const research = req.research;
  if (research) {
    sections.push('', '### 买家反馈摘要（[RESEARCH] 深度调研，人终判的参考）');
    sections.push(`舆情倾向: ${research.sentiment}`);
    if (research.highlights.length > 0) {
      sections.push('买家好评集中:');
      for (const h of research.highlights) sections.push(`- ${clipText(h, 100)}`);
    }
    if (research.materialPoints.length > 0) {
      sections.push('买家真实关注点（优先用作内容素材与选材角度）:');
      for (const m of research.materialPoints) sections.push(`- ${clipText(m, 100)}`);
    }
    if (research.risks.length > 0) {
      sections.push('风险信号（内容中不要做与这些冲突的宣称）:');
      for (const r of research.risks) sections.push(`- ${clipText(r, 100)}`);
    }
  }

  const revision = req.revision ?? [];
  if (revision.length > 0) {
    sections.push('', '## 修订任务（只重做下面列出的平台，未列出的不要重新保存）');
    for (const t of revision) {
      sections.push('', `### ${PLATFORM_LABEL[t.platform]}（需修订）`);
      if (t.previous) {
        sections.push('之前版本 [DATA]:', '```json', JSON.stringify(t.previous, null, 2), '```');
      } else {
        sections.push('（该平台上一轮未产出，请补齐）');
      }
      sections.push('问题（逐条修复）:');
      for (const issue of t.issues) sections.push(`- ${issue}`);
    }
    sections.push('', '修复后按任务包结构重新调用对应 save 工具，然后调用 submit_content。');
  } else {
    sections.push('', '请按任务包流程执行：先 save_xiaohongshu，再 save_douyin，全部保存后调用 submit_content。');
  }

  return { system, prompt: sections.join('\n') };
}

/** AI SDK 实现（generateText + 工具循环 + stopWhen: stepCountIs 硬限） */
export function createAiSdkContentAgent(opts: {
  model: LanguageModel;
  modelName: string;
  maxSteps?: number;
}): ContentAgent {
  const maxSteps = opts.maxSteps ?? 6;
  return {
    name: `ai-sdk:${opts.modelName}`,
    async generate(req: ContentRequest): Promise<ContentAgentResult> {
      const { system, prompt } = buildContentPrompt(req);

      // 运行态：只在本次调用内有效（数组收集，闭包内 push，结束后取最后一条）
      const xhs: XiaohongshuNote[] = [];
      const dy: DouyinScript[] = [];
      let submitted = false;

      const saveXiaohongshu = tool({
        description: '保存小红书种草笔记草稿（真实使用视角，卖点只准来自输入字段）',
        inputSchema: z.object({
          title: z.string().min(5).max(20),
          body: z.string().min(150).max(500),
          tags: z.array(z.string().min(1).max(20)).min(3).max(8),
          cover_idea: z.string().max(50).nullish(),
        }),
        execute: async (args) => {
          xhs.push({ title: args.title, body: args.body, tags: args.tags, coverIdea: args.cover_idea ?? null });
          return { ok: true, saved: 'xiaohongshu' };
        },
      });

      const saveDouyin = tool({
        description: '保存抖音口播脚本草稿（钩子 / 卖点 / 行动指令）',
        inputSchema: z.object({
          hook: z.string().min(5).max(30),
          points: z.array(z.string().min(5).max(100)).min(2).max(4),
          cta: z.string().min(5).max(50),
        }),
        execute: async (args) => {
          dy.push({ hook: args.hook, points: args.points, cta: args.cta });
          return { ok: true, saved: 'douyin' };
        },
      });

      const submitContent = tool({
        description: '提交内容草稿，任务结束',
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
        tools: { save_xiaohongshu: saveXiaohongshu, save_douyin: saveDouyin, submit_content: submitContent },
        temperature: 0.7, // 内容需要创意；理由生成走默认温度
        stopWhen: stepCountIs(maxSteps),
      });

      const xiaohongshu = xhs[xhs.length - 1] ?? null;
      const douyin = dy[dy.length - 1] ?? null;
      const degraded = !submitted || !xiaohongshu || !douyin;

      return {
        xiaohongshu,
        douyin,
        submitted,
        degraded,
        audit: {
          purpose: 'content-gen:drafts',
          model: opts.modelName,
          skill: CONTENT_SKILL_VERSION,
          input: { prompt },
          output: {
            revision: (req.revision?.length ?? 0) > 0,
            steps: result.steps.length,
            toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
            finishReason: result.finishReason,
            xiaohongshuSaved: xhs.length,
            douyinSaved: dy.length,
            submitted,
          },
        },
      };
    },
  };
}

/** 从环境变量构造 OpenAI Agent；无 key 返回 null（流水线自动标记 needs_manual） */
export function createContentAgentFromEnv(): ContentAgent | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const modelName = process.env.GWD_LLM_MODEL ?? 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
  return createAiSdkContentAgent({ model: openai(modelName), modelName });
}

/** 按品稳定取模选句式：同品重跑内容一致（幂等），跨品错开角度（模拟真实 LLM 的跨品差异，避免脚本化产出被去重层误报） */
function stableIndex(seed: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** 句式池（3 套视角）：opening/middle/tail 为小红书正文骨架，hook/points/cta 为抖音脚本 */
const SCRIPT_VARIANTS = [
  {
    titlePrefix: '开箱｜',
    opening: (t: string) => `${t}到货两天，来交个作业。`,
    middle: '实际用下来做工没有廉价感，日常场景完全够用，细节比想象中到位。',
    tail: ['有同款需求的朋友可以参考，链接放评论区置顶了。', '有问题评论区问我，看到都会回，打算再用两周回来追评。'],
    tags: ['开箱', '实测'],
    coverIdea: '开箱摆放 + 价格标签',
    hook: (c: string) => `这个${c}我不允许还有人不知道`,
    points: (price: number | null, t: string) => [
      price != null ? `${price} 元入手，这个价位能打` : '价格不贵，这个价位能打',
      `${t}，实际体验超出预期`,
      '日常使用频率比想象中高，不吃灰',
    ],
    cta: '想知道链接的看评论区置顶',
  },
  {
    titlePrefix: '真心话｜',
    opening: (t: string) => `${t}蹲了很久才下单，用了一周说点真实感受。`,
    middle: '同价位对比过三款，做工和顺手程度是我留下它的原因，没有踩雷的感觉。',
    tail: ['有需要的朋友直接看评论区，链接已置顶。', '还想了解什么细节可以留言，我都会回复。'],
    tags: ['选购指南', '真心话'],
    coverIdea: '对比表格 + 结论前置',
    hook: (c: string) => `别再乱买${c}了，先看这条再说`,
    points: (price: number | null, t: string) => [
      price != null ? `入手价 ${price} 元，性价比在线` : '入手价不贵，性价比在线',
      `${t}，做工细节经得起细看`,
      '同价位里我会优先推荐这款',
    ],
    cta: '链接放在评论区置顶了',
  },
  {
    titlePrefix: '无滤镜｜',
    opening: (t: string) => `${t}是被朋友种草的，来交一份无滤镜反馈。`,
    middle: '收到先检查了做工，边缘处理得干净，上手比想象中顺手，日常需求都能覆盖到。',
    tail: ['链接我放在评论区置顶了，有需要自取。', '打算再用两周，有新的体会再回来追评。'],
    tags: ['无滤镜', '朋友推荐'],
    coverIdea: '使用场景 + 真实滤镜',
    hook: (c: string) => `${c}怎么挑不踩雷？看完这条就会了`,
    points: (price: number | null, t: string) => [
      price != null ? `预算 ${price} 元以内的可以看看` : '预算有限的可以看看这款',
      `${t}，真实体验之后来汇报`,
      '用了一周，没发现明显短板',
    ],
    cta: '同款链接在评论区第一个',
  },
];

/** 脚本化 Agent：测试与 `gwd demo` 用（走同样的结构校验，卖点来自输入字段） */
export function createScriptedContentAgent(): ContentAgent {
  return {
    name: 'scripted',
    async generate(req: ContentRequest): Promise<ContentAgentResult> {
      const p = req.product;
      const shortTitle = p.title.slice(0, 14);
      const v = SCRIPT_VARIANTS[stableIndex(p.externalId, SCRIPT_VARIANTS.length)]!;
      const body = [
        v.opening(shortTitle),
        p.price != null ? `${p.price} 元入手，这个价位我原本没抱太大期待。` : '价格见橱窗链接。',
        p.category ? `${p.category}类目里对比了好几款，最后选了它。` : '同类产品对比过几款，最后选了它。',
        v.middle,
        p.reviewRate != null ? `商家页面显示好评率 ${p.reviewRate}%，和我自己的体验基本一致。` : '',
        ...v.tail,
      ]
        .filter(Boolean)
        .join('');
      const xiaohongshu = XiaohongshuNoteSchema.parse({
        title: `${v.titlePrefix}${shortTitle}`,
        body,
        tags: [p.category ?? '好物分享', ...v.tags],
        coverIdea: v.coverIdea,
      });
      const douyin = DouyinScriptSchema.parse({
        hook: v.hook(p.category ?? '好物'),
        points: v.points(p.price, shortTitle),
        cta: v.cta,
      });

      const revision = req.revision ?? [];
      const inRevision = revision.length > 0;
      return {
        // 修订模式只返回列出平台的内容（管线也只取列出的平台）
        xiaohongshu: !inRevision || revision.some((t) => t.platform === 'xiaohongshu') ? xiaohongshu : null,
        douyin: !inRevision || revision.some((t) => t.platform === 'douyin') ? douyin : null,
        submitted: true,
        degraded: false,
        audit: {
          purpose: 'content-gen:drafts',
          model: 'scripted',
          skill: CONTENT_SKILL_VERSION,
          input: { prompt: `${inRevision ? 'revision' : 'product'}: ${p.externalId}` },
          output: { revision: inRevision, xiaohongshuSaved: 1, douyinSaved: 1, submitted: true },
        },
      };
    },
  };
}
