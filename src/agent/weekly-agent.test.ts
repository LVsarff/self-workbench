﻿/**
 * 周报复盘叙事 Agent（weekly-narrative）测试：
 * - applyRulePatches：白名单 / 值域 / 类型 / 温和幅度 / 业务不变量（宁拒勿错）
 * - validateNarrative：禁词零命中 + 长度
 * - validateRuleSuggestions：逐条独立校验，非法整条丢弃
 * - buildWeeklyPrompt：外部 caption 截断 + [DATA] 段界包裹（进 user 位）
 * - AI SDK 实现（mock 模型）：提交即校验，越权 patch 被过滤
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { RULE_V1 } from '../core/rule-config.js';
import type { SimContentStatRow } from '../db/repo.js';
import { buildSimWeeklyReport, type SimWeeklyReport } from '../pipeline/sim-weekly.js';
import {
  applyRulePatches,
  buildWeeklyPrompt,
  createAiSdkWeeklyAgent,
  createScriptedWeeklyAgent,
  validateNarrative,
  validateRuleSuggestions,
  type AiRuleSuggestion,
} from './weekly-agent.js';

function stat(overrides: Partial<SimContentStatRow> = {}): SimContentStatRow {
  return {
    source: 'kuairec',
    videoId: 'v1',
    authorId: 'A1',
    statDate: '2020-08-10',
    videoType: null,
    uploadDt: null,
    videoDuration: null,
    videoTagName: null,
    showCnt: 10000,
    playCnt: 5000,
    completePlayCnt: 2500,
    likeCnt: 500,
    commentCnt: 50,
    shareCnt: 50,
    followCnt: 100,
    collectCnt: 0,
    reportCnt: 0,
    caption: '测试文案',
    topicTag: null,
    category: '颜值·颜值随拍',
    ...overrides,
  };
}

/** 完播率环比下滑 10pp 的周报（触发规则建议的典型场景） */
function report(): SimWeeklyReport {
  const rows = [
    stat({ statDate: '2020-07-29', showCnt: 50000, playCnt: 25000, completePlayCnt: 10000 }),
    stat({ statDate: '2020-08-10', showCnt: 50000, playCnt: 25000, completePlayCnt: 7500 }),
  ];
  return buildSimWeeklyReport(rows, 'A1', '2020-08-10');
}

describe('applyRulePatches（patch 白名单 + 合成校验）', () => {
  it('合法温和调整：strongMin 80 → 82，其余不动，version 保留基准', () => {
    const out = applyRulePatches(RULE_V1, [{ path: 'grading.strongMin', value: 82, reason: '完播率下滑，抬高强推门槛' }]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.config.grading.strongMin).toBe(82);
      expect(out.config.gates.minCommissionRate).toBe(RULE_V1.gates.minCommissionRate);
      expect(out.config.version).toBe(RULE_V1.version);
    }
  });

  it('绝对点规则：minCommissionRate 15 → 20（相对 33% 超限但绝对 5 点内）→ 通过', () => {
    const out = applyRulePatches(RULE_V1, [{ path: 'gates.minCommissionRate', value: 20, reason: '测试' }]);
    expect(out.ok).toBe(true);
  });

  it('白名单之外一律拒绝（version / 禁售词表 / 满分结构）', () => {
    for (const path of ['version', 'gates.bannedCategoryKeywords', 'scoring.commission', '__proto__', '']) {
      const out = applyRulePatches(RULE_V1, [{ path, value: 1, reason: '越权' }]);
      expect(out.ok).toBe(false);
    }
  });

  it('值域越界 / 非整数 → 拒绝', () => {
    expect(applyRulePatches(RULE_V1, [{ path: 'grading.strongMin', value: 200, reason: 'x' }]).ok).toBe(false);
    expect(applyRulePatches(RULE_V1, [{ path: 'topN', value: 0, reason: 'x' }]).ok).toBe(false);
    expect(applyRulePatches(RULE_V1, [{ path: 'grading.strongMin', value: 82.5, reason: 'x' }]).ok).toBe(false);
  });

  it('幅度过大 → 拒绝（topN 5 → 11：相对 >30% 且绝对 >5 点）', () => {
    expect(applyRulePatches(RULE_V1, [{ path: 'topN', value: 11, reason: 'x' }]).ok).toBe(false);
  });

  it('业务不变量冲突（testMin 抬到 ≥ strongMin）→ 合成时刻被 parseRuleConfig 拒绝', () => {
    const out = applyRulePatches(RULE_V1, [{ path: 'grading.testMin', value: 80, reason: 'x' }]);
    expect(out.ok).toBe(false);
  });

  it('一组内任一 patch 非法 → 整组拒绝（不半途应用）', () => {
    const out = applyRulePatches(RULE_V1, [
      { path: 'grading.strongMin', value: 82, reason: '合法' },
      { path: 'gates.minReviewRate', value: 999, reason: '非法' },
    ]);
    expect(out.ok).toBe(false);
  });
});

describe('validateNarrative（禁词 + 长度）', () => {
  it('正常叙事通过', () => {
    const s = '本周曝光环比下滑，完播率走弱 10pp，头部内容仍贡献主要流量，建议复盘开头与题材匹配度。';
    expect(validateNarrative(s)).toBe(s);
  });

  it('命中广告法禁词（最好）→ 丢弃', () => {
    expect(validateNarrative('这是最好的周报复盘叙事，曝光与完播率双双走弱，建议人工复盘题材匹配度与开头节奏。')).toBeNull();
  });

  it('长度越界（<40 / >300）→ 丢弃', () => {
    expect(validateNarrative('太短')).toBeNull();
    expect(validateNarrative('长'.repeat(301))).toBeNull();
  });
});

describe('validateRuleSuggestions（逐条独立校验）', () => {
  const good: AiRuleSuggestion = {
    basis: '完播率环比 -10pp，有量内容留不住人',
    expectedEffect: '抬高强推门槛观察下周完播率回升',
    patches: [{ path: 'grading.strongMin', value: 82, reason: '温和抬高' }],
  };

  it('合法建议通过', () => {
    expect(validateRuleSuggestions([good], RULE_V1)).toHaveLength(1);
  });

  it('非法建议（越权路径）整条丢弃，不阻塞其余', () => {
    const bad: AiRuleSuggestion = { ...good, patches: [{ path: 'version', value: 99, reason: '越权' }] };
    expect(validateRuleSuggestions([bad, good], RULE_V1)).toHaveLength(1);
  });

  it('空 patches → 丢弃', () => {
    expect(validateRuleSuggestions([{ ...good, patches: [] }], RULE_V1)).toHaveLength(0);
  });
});

describe('buildWeeklyPrompt（注入防护 + 数据进 user 位）', () => {
  it('周报数据与规则摘要都在 [DATA BEGIN]/[DATA END] 段内，且出现在 user 位 prompt 而非 system', () => {
    const { system, prompt } = buildWeeklyPrompt({ report: report(), rule: RULE_V1 });
    expect(prompt).toContain('[DATA BEGIN]');
    expect(prompt).toContain('[DATA END]');
    expect(prompt).toContain('周报结构化数据');
    expect(prompt).toContain('当前 active 规则摘要');
    // system 只放骨架 + 任务包：任务包会"描述性提及"输入类别名，但不含实际账号数据
    expect(system).not.toContain('A1'); // 账号数据只在 user 位
    expect(system).not.toContain('50000'); // 本周曝光数只在 user 位
  });

  it('超长 caption 截断（带截断标记，不撑爆 prompt）', () => {
    const long = '超'.repeat(300);
    const r = buildSimWeeklyReport([stat({ statDate: '2020-08-10', caption: long })], 'A1', '2020-08-10');
    const { prompt } = buildWeeklyPrompt({ report: r, rule: RULE_V1 });
    expect(prompt).toContain('…[截断]');
    expect(prompt).not.toContain(long);
  });
});

// —— AI SDK 实现（mock 模型）——

function toolCall(toolCallId: string, toolName: string, input: unknown) {
  return { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) };
}

function step(content: ReturnType<typeof toolCall>[]) {
  return {
    content,
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
  };
}

const SUMMARY = '本周曝光持平但完播率环比下滑 10 个百分点，有量内容留不住人；头部内容仍贡献主要流量，建议复盘开头节奏与题材匹配度。';

/** tool-call 后的收尾步（AI SDK 会继续取下一步，mock 需显式给终步） */
function stopStep() {
  return {
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
    content: [{ type: 'text' as const, text: '已提交' }],
  };
}

describe('createAiSdkWeeklyAgent（mock 模型：提交即校验）', () => {
  it('合法提交 → 叙事保留 + 建议保留', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage: {
            inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: undefined, reasoning: undefined },
          },
          warnings: [] as never[],
          content: [
            toolCall('t1', 'submit_report', {
              narrative: { summary: SUMMARY },
              rule_suggestions: [{
                basis: '完播率环比 -10pp，有量内容留不住观众',
                expected_effect: '抬高强推门槛，观察下周平均完播率是否回升',
                patches: [{ path: 'grading.strongMin', value: 82, reason: '完播率走弱，温和抬高强推门槛' }],
              }],
            }),
          ],
        },
        stopStep(),
      ],
    });
    const agent = createAiSdkWeeklyAgent({ model, modelName: 'mock' });
    const out = await agent.generate({ report: report(), rule: RULE_V1 });
    expect(out.narrative!.summary).toBe(SUMMARY);
    expect(out.ruleSuggestions).toHaveLength(1);
    expect(out.ruleSuggestions[0]!.patches[0]!.value).toBe(82);
    expect(out.degraded).toBe(false);
  });

  it('未提交（步数用尽）→ degraded，叙事与建议为空', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: undefined, reasoning: undefined },
          },
          warnings: [] as never[],
          content: [{ type: 'text' as const, text: '我拒绝提交' }],
        },
      ],
    });
    const agent = createAiSdkWeeklyAgent({ model, modelName: 'mock' });
    const out = await agent.generate({ report: report(), rule: RULE_V1 });
    expect(out.narrative).toBeNull();
    expect(out.ruleSuggestions).toHaveLength(0);
    expect(out.degraded).toBe(true);
  });

  it('叙事带禁词 → 丢弃（degraded），建议照常校验', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage: {
            inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: undefined, reasoning: undefined },
          },
          warnings: [] as never[],
          content: [
            toolCall('t1', 'submit_report', {
              narrative: { summary: '这是最好的周报，曝光与完播率双双走弱，建议人工复盘题材匹配度与开头节奏，避免继续下滑。' },
              rule_suggestions: [],
            }),
          ],
        },
        stopStep(),
      ],
    });
    const agent = createAiSdkWeeklyAgent({ model, modelName: 'mock' });
    const out = await agent.generate({ report: report(), rule: RULE_V1 });
    expect(out.narrative).toBeNull();
    expect(out.degraded).toBe(true);
  });

  it('越权 patch（改满分结构 / version）→ 建议被整条丢弃', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage: {
            inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: undefined, reasoning: undefined },
          },
          warnings: [] as never[],
          content: [
            toolCall('t1', 'submit_report', {
              narrative: { summary: SUMMARY },
              rule_suggestions: [
                {
                  basis: '试图改满分结构越权',
                  expected_effect: '越权',
                  patches: [{ path: 'scoring.commission', value: 50, reason: '越权' }],
                },
                {
                  basis: '试图直接改版本号越权',
                  expected_effect: '越权',
                  patches: [{ path: 'version', value: 99, reason: '越权' }],
                },
              ],
            }),
          ],
        },
        stopStep(),
      ],
    });
    const agent = createAiSdkWeeklyAgent({ model, modelName: 'mock' });
    const out = await agent.generate({ report: report(), rule: RULE_V1 });
    expect(out.ruleSuggestions).toHaveLength(0);
    expect(out.degraded).toBe(true);
  });
});

describe('createScriptedWeeklyAgent（脚本化：走同样校验路径）', () => {
  it('完播率下滑场景 → 叙事 + 一条温和 strongMin 上调建议（过全量校验）', async () => {
    const agent = createScriptedWeeklyAgent();
    const out = await agent.generate({ report: report(), rule: RULE_V1 });
    expect(out.narrative).not.toBeNull();
    expect(out.ruleSuggestions).toHaveLength(1);
    const patch = out.ruleSuggestions[0]!.patches[0]!;
    expect(patch.path).toBe('grading.strongMin');
    expect(Math.abs(patch.value - RULE_V1.grading.strongMin)).toBeLessThanOrEqual(5);
  });

  it('完播率平稳场景 → 无规则建议（宁缺勿滥）', async () => {
    const rows = [stat({ statDate: '2020-07-29' }), stat({ statDate: '2020-08-10' })];
    const r = buildSimWeeklyReport(rows, 'A1', '2020-08-10');
    const out = await createScriptedWeeklyAgent().generate({ report: r, rule: RULE_V1 });
    expect(out.ruleSuggestions).toHaveLength(0);
    expect(out.degraded).toBe(false);
  });

  it('建议可合成合法 config（rule propose 兼容）', async () => {
    const agent = createScriptedWeeklyAgent();
    const out = await agent.generate({ report: report(), rule: RULE_V1 });
    const applied = applyRulePatches(RULE_V1, out.ruleSuggestions[0]!.patches);
    expect(applied.ok).toBe(true);
  });
});

