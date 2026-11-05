/**
 * 周报复盘叙事 Agent（模块⑤ 第二批：周报 AI 叙事 + 规则调整建议完整版）。
 * 与 grade-agent 同运行时模式（骨架 Prompt + 任务包 + 单工具提交 + 步数硬限）。
 *
 * 语义边界（务必分清）：
 * - 输入是零 LLM 骨架算好的 SimWeeklyReport——数字是系统算的，Agent 只解释与建议
 * - 规则建议以「参数 patch」表达：LLM 永远拿不到完整宪法改写权，
 *   只能在白名单路径上做温和调整，完整 config 由系统基于 active 规则合成
 *   并过 parseRuleConfig 校验——产物直接兼容 gwd rule propose（人批准门在前）
 * - LLM 调用入 llm_call_logs 审计；temperature 0
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { checkBannedWords } from '../core/banned-words.js';
import { dataSection } from '../core/prompt-guard.js';
import { parseRuleConfig, ruleSummary, type RuleConfig } from '../core/rule-config.js';
import type { SimWeeklyReport } from '../pipeline/sim-weekly.js';
import { SKELETON } from './reason-agent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_WEEKLY_NARRATIVE = readFileSync(join(HERE, 'skills', 'weekly-narrative', 'SKILL.md'), 'utf8');
export const WEEKLY_SKILL_VERSION = 'weekly-narrative@1';

// —— 规则 patch 白名单（LLM 可建议的全部路径；值域 + 类型显式声明）——

interface PatchSpec {
  min: number;
  max: number;
  integer: boolean;
}

export const PATCH_WHITELIST: Readonly<Record<string, PatchSpec>> = {
  'gates.minCommissionRate': { min: 0, max: 50, integer: false },
  'gates.minReviewRate': { min: 0, max: 100, integer: false },
  'gates.maxReturnRate': { min: 1, max: 100, integer: false },
  'gates.minMerchantScore': { min: 0, max: 100, integer: false },
  'grading.strongMin': { min: 1, max: 100, integer: true },
  'grading.testMin': { min: 1, max: 100, integer: true },
  topN: { min: 1, max: 20, integer: true },
};

/** 温和幅度：相对变化 ≤ 30% 或绝对变化 ≤ 5 个点（任一满足即可） */
export function withinModerateRange(value: number, current: number): boolean {
  return Math.abs(value - current) <= current * 0.3 || Math.abs(value - current) <= 5;
}

export interface RulePatch {
  path: string;
  value: number;
  reason: string;
}

export interface AiRuleSuggestion {
  basis: string;
  expectedEffect: string;
  patches: RulePatch[];
}

export interface WeeklyAgentRequest {
  report: SimWeeklyReport;
  rule: RuleConfig;
}

export interface WeeklyAgentResult {
  narrative: { summary: string } | null;
  ruleSuggestions: AiRuleSuggestion[];
  /** 叙事或建议未完整产出（失败 / 超步数 / 校验丢弃） */
  degraded: boolean;
  audit: {
    purpose: string;
    model: string;
    skill: string;
    input: unknown;
    output: unknown;
  };
}

export interface WeeklyAgent {
  name: string;
  generate(req: WeeklyAgentRequest): Promise<WeeklyAgentResult>;
}

/** 商家可控文本截断（caption 来自数据集，同 clip 策略） */
function clipText(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length <= max ? text : `${text.slice(0, max)}…[截断]`;
}

const CAPTION_MAX = 80;

/** 周报 → 注入上下文的快照（caption 截断；全部走 [DATA] 段，进 user 位） */
function reportToInput(report: SimWeeklyReport): Record<string, unknown> {
  const clipContents = (cs: Array<{ caption: string | null }>) =>
    cs.map((c) => ({ ...c, caption: clipText(c.caption, CAPTION_MAX) }));
  return {
    author_id: report.authorId,
    current_week: report.currentWeek,
    previous_week: report.previousWeek,
    comparison: report.comparison,
    anomalies: report.anomalies,
    top_contents: clipContents(report.topContents),
    bottom_contents: clipContents(report.bottomContents),
    rule_triggered_suggestions: report.suggestions,
  };
}

export function buildWeeklyPrompt(req: WeeklyAgentRequest): { system: string; prompt: string } {
  const system = `${SKELETON}\n\n# 当前任务包\n${SKILL_WEEKLY_NARRATIVE}`;
  const prompt = [
    `## 周报输入（账号 ${req.report.authorId} · 本周 ${req.report.currentWeek.dateFrom} ~ ${req.report.currentWeek.dateTo}）`,
    dataSection('周报结构化数据（系统计算，数字不可置疑）', [
      JSON.stringify(reportToInput(req.report), null, 2),
    ]),
    dataSection('当前 active 规则摘要', [ruleSummary(req.rule)]),
    '',
    '请按任务包流程执行：先叙事、再给规则建议（数据不支撑就给空数组），调用 submit_report 一次性提交。',
  ].join('\n');
  return { system, prompt };
}

const SubmitReportSchema = z.object({
  narrative: z.object({
    summary: z.string().min(40).max(300),
  }),
  rule_suggestions: z
    .array(
      z.object({
        basis: z.string().min(10).max(300),
        expected_effect: z.string().min(5).max(200),
        patches: z
          .array(
            z.object({
              path: z.string(),
              value: z.number(),
              reason: z.string().min(3).max(200),
            }),
          )
          .min(1)
          .max(5),
      }),
    )
    .max(3),
});

/** submit_report 入参 schema（与任务包输出契约一致） */
export { SubmitReportSchema };

/** submit_report 入参类型（显式声明：与 schema 契约一致） */
interface SubmitReportInput {
  narrative: { summary: string };
  rule_suggestions: Array<{
    basis: string;
    expected_effect: string;
    patches: Array<{ path: string; value: number; reason: string }>;
  }>;
}

/** 点路径读值（白名单已限定两段以内，不递归展开） */
function getPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** 点路径写值（深拷贝上执行，原对象不可变） */
function setPath(obj: Record<string, unknown>, path: string, value: number): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) {
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * 应用 patch 合成新规则配置：深拷贝 active 规则 → 逐 patch 写入 → parseRuleConfig 全量校验。
 * 任何 patch 非法（路径 / 值域 / 类型 / 幅度 / 业务不变量）→ 整组拒绝（不半途应用）。
 */
export function applyRulePatches(
  rule: RuleConfig,
  patches: RulePatch[],
): { ok: true; config: RuleConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const p of patches) {
    const spec = PATCH_WHITELIST[p.path];
    if (spec == null) {
      errors.push(`patch 路径不在白名单：${p.path}`);
      continue;
    }
    if (!Number.isFinite(p.value) || p.value < spec.min || p.value > spec.max) {
      errors.push(`patch 值越界：${p.path} = ${p.value}（允许 ${spec.min}~${spec.max}）`);
      continue;
    }
    if (spec.integer && !Number.isInteger(p.value)) {
      errors.push(`patch 值须为整数：${p.path} = ${p.value}`);
      continue;
    }
    const current = getPath(rule, p.path);
    if (typeof current !== 'number') {
      errors.push(`patch 路径在当前规则中不存在或非数值：${p.path}`);
      continue;
    }
    if (!withinModerateRange(p.value, current)) {
      errors.push(`patch 幅度过大：${p.path} ${current} → ${p.value}（须 ≤ 30% 相对或 ≤ 5 个点）`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const draft = structuredClone(rule) as unknown as Record<string, unknown>;
  for (const p of patches) setPath(draft, p.path, p.value);
  const parsed = parseRuleConfig(draft);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  return { ok: true, config: { ...parsed.config, version: rule.version } };
}

/**
 * 危险命令载荷特征（输出侧硬检查）。
 * 对抗测试攻破点回流第 2 步的修复：叙事文本面向人展示，不应携带 shell/代码执行语义——
 * 禁词表（广告法）不覆盖这类载荷，此处单独拦截。
 */
export const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+-r[rf]?\b/i,
  /curl[^;\n]{0,80}\|\s*(ba)?sh\b/i,
  /\bos\.system\s*\(/i,
  /\beval\s*\(/,
  /\bexec\s*\(/i,
  /drop\s+table/i,
  /powershell|cmd\.exe|\/bin\/(ba)?sh\b/i,
  /\bchild_process\b/i,
];

/**
 * 校验叙事：禁词零命中（checkBannedWords）+ 危险载荷零命中 + 长度合规。
 * 命中任一 → 丢弃整段叙事（degraded，流水线降级为零 LLM 骨架呈现）。
 */
export function validateNarrative(summary: string): string | null {
  if (summary.length < 40 || summary.length > 300) return null;
  if (checkBannedWords(summary).length > 0) return null;
  if (DANGEROUS_PATTERNS.some((re) => re.test(summary))) return null;
  return summary;
}

/**
 * 校验规则建议（逐条独立）：patch 白名单 + 值域 + 幅度 + 合成 config 全量校验。
 * 非法建议整条丢弃（宁缺勿滥），不阻塞其余建议。
 */
export function validateRuleSuggestions(
  suggestions: AiRuleSuggestion[],
  rule: RuleConfig,
): AiRuleSuggestion[] {
  const out: AiRuleSuggestion[] = [];
  for (const s of suggestions) {
    if (s.patches.length === 0) continue;
    const applied = applyRulePatches(rule, s.patches);
    if (!applied.ok) continue; // 非法 patch → 整条丢弃
    out.push(s);
  }
  return out;
}

/** AI SDK 实现（单工具提交 + 步数硬限；未提交 = degraded） */
export function createAiSdkWeeklyAgent(opts: {
  model: LanguageModel;
  modelName: string;
  maxSteps?: number;
}): WeeklyAgent {
  const maxSteps = opts.maxSteps ?? 3;
  return {
    name: `ai-sdk:${opts.modelName}`,
    async generate(req: WeeklyAgentRequest): Promise<WeeklyAgentResult> {
      const { system, prompt } = buildWeeklyPrompt(req);
      // 数组收集（TS 控制流对"仅闭包内赋值的 let"会收窄为 null，数组模式与 grade-agent 一致）
      const captured: SubmitReportInput[] = [];

      const submitReport = tool({
        description: '一次性提交周报叙事与规则调整建议',
        inputSchema: SubmitReportSchema,
        execute: async (args) => {
          captured[0] = args;
          return { ok: true };
        },
      });

      const result = await generateText({
        model: opts.model,
        instructions: system,
        prompt,
        tools: { submit_report: submitReport },
        temperature: 0,
        stopWhen: stepCountIs(maxSteps),
      });

      const report = captured[0] ?? null;
      const submitted = report != null;
      const narrativeSummary = report ? validateNarrative(report.narrative.summary) : null;
      const ruleSuggestions = report
        ? validateRuleSuggestions(
            report.rule_suggestions.map((s) => ({
              basis: s.basis,
              expectedEffect: s.expected_effect,
              patches: s.patches.map((p) => ({ path: p.path, value: p.value, reason: p.reason })),
            })),
            req.rule,
          )
        : [];
      // 降级定义：未提交 / 叙事被禁词校验丢弃 / 建议被校验丢弃过
      const degraded =
        !submitted || narrativeSummary == null || ruleSuggestions.length < (report?.rule_suggestions.length ?? 0);

      return {
        narrative: narrativeSummary == null ? null : { summary: narrativeSummary },
        ruleSuggestions,
        degraded,
        audit: {
          purpose: 'weekly-narrative:report',
          model: opts.modelName,
          skill: WEEKLY_SKILL_VERSION,
          input: { system, prompt },
          output: {
            steps: result.steps.length,
            toolCalls: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)),
            finishReason: result.finishReason,
            submitted,
            narrativeKept: narrativeSummary != null,
            suggestionsIn: report?.rule_suggestions.length ?? 0,
            suggestionsKept: ruleSuggestions.length,
          },
        },
      };
    },
  };
}

/** 从环境变量构造；无 key 返回 null（流水线自动降级零 LLM 骨架） */
export function createWeeklyAgentFromEnv(): WeeklyAgent | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const modelName = process.env.GWD_LLM_MODEL ?? 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
  return createAiSdkWeeklyAgent({ model: openai(modelName), modelName });
}

/**
 * 脚本化 Agent：测试与 `gwd demo` 用（走同样的校验路径）。
 * 叙事从环比数据确定性生成；规则建议只在「完播率下滑 ≥ 5pp」触发时给一条温和上调。
 */
export function createScriptedWeeklyAgent(): WeeklyAgent {
  return {
    name: 'scripted-weekly',
    async generate(req: WeeklyAgentRequest): Promise<WeeklyAgentResult> {
      const { report, rule } = req;
      const c = report.comparison.changes;
      const parts: string[] = [];
      if (c.showCnt != null) {
        parts.push(`曝光环比${c.showCnt >= 0 ? '上升' : '下滑'} ${Math.abs(c.showCnt * 100).toFixed(1)}%`);
      } else {
        parts.push('曝光无上周对比');
      }
      if (c.completeRatePp != null) {
        parts.push(`完播率${c.completeRatePp >= 0 ? '改善' : '下滑'} ${Math.abs(c.completeRatePp * 100).toFixed(1)}pp`);
      }
      if (report.anomalies.length > 0) {
        parts.push(`本周 ${report.anomalies.length} 个异常日`);
      }
      const top = report.topContents[0];
      if (top) parts.push(`头部内容 [${top.videoId}] 贡献曝光 ${top.showCnt.toLocaleString()}`);
      const summary = `本周复盘：${parts.join('；')}。以上为模拟数据口径结论，供人工复盘参考，参数未验证。`;

      const suggestions: AiRuleSuggestion[] = [];
      if (c.completeRatePp != null && c.completeRatePp <= -0.05) {
        suggestions.push({
          basis: `完播率环比 ${(report.comparison.previous!.completeRate * 100).toFixed(1)}% → ${(report.comparison.current.completeRate * 100).toFixed(1)}%（${(c.completeRatePp * 100).toFixed(1)}pp），有量内容留不住人`,
          expectedEffect: '抬高强推门槛，筛掉留不住观众的品，观察下周强推清单平均完播率是否回升',
          patches: [{ path: 'grading.strongMin', value: Math.min(100, rule.grading.strongMin + 2), reason: '完播率连续走弱，温和抬高强推门槛' }],
        });
      }

      const narrativeSummary = validateNarrative(summary);
      const kept = validateRuleSuggestions(suggestions, rule);
      return {
        narrative: narrativeSummary == null ? null : { summary: narrativeSummary },
        ruleSuggestions: kept,
        degraded: narrativeSummary == null,
        audit: {
          purpose: 'weekly-narrative:report',
          model: 'scripted',
          skill: WEEKLY_SKILL_VERSION,
          input: { authorId: report.authorId, week: report.currentWeek },
          output: { narrativeKept: narrativeSummary != null, suggestionsKept: kept.length },
        },
      };
    },
  };
}
