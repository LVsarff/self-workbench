/**
 * 周报 AI 叙事流水线（sim-weekly-ai）测试：
 * - 无 agent → 降级零 LLM 骨架（narrativeSource none，不记 LLM 日志）
 * - 预算熔断 → 不调用 agent，budgetExceeded 标记
 * - 正常路径 → 叙事 + 提案草案（rule propose 兼容：parseRuleConfig 通过）
 * - agent 抛错 → 落审计日志 + 降级
 * 红线：AI 建议只是提案草案，active 规则在人批准前永不变。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1, parseRuleConfig } from '../core/rule-config.js';
import type { SimContentStatRow } from '../db/repo.js';
import { createScriptedWeeklyAgent, type WeeklyAgent, type WeeklyAgentResult } from '../agent/weekly-agent.js';
import { runSimWeeklyAI } from './sim-weekly-ai.js';

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

async function setup(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'test-init', approvedBy: 'tester' });
  return repo;
}

/** 注入「完播率环比下滑」的两周数据 */
async function seedWeeklyData(repo: MemoryRepo): Promise<void> {
  await repo.upsertSimStats([
    stat({ statDate: '2020-07-29', showCnt: 50000, playCnt: 25000, completePlayCnt: 10000 }),
    stat({ statDate: '2020-08-10', showCnt: 50000, playCnt: 25000, completePlayCnt: 7500 }),
  ]);
}

describe('runSimWeeklyAI', () => {
  it('无 agent → 降级零 LLM 骨架：narrative null、无提案、不记 LLM 日志', async () => {
    const repo = await setup();
    await seedWeeklyData(repo);
    const r = await runSimWeeklyAI({ repo, agent: null, weekEnd: '2020-08-10' });
    expect(r.narrative).toBeNull();
    expect(r.narrativeSource).toBe('none');
    expect(r.proposals).toHaveLength(0);
    expect(r.degraded).toBe(false); // 没请求 LLM 就不算降级
    expect(r.budgetExceeded).toBe(false);
    expect(await repo.countLlmCallsToday()).toBe(0);
    // 骨架永远可用
    expect(r.report.comparison.current.showCnt).toBe(50000);
    expect(r.activeRule.version).toBe(1);
  });

  it('预算熔断 → 不调用 agent，budgetExceeded 标记，不记日志', async () => {
    const repo = await setup();
    await seedWeeklyData(repo);
    // 预灌 3 条今日日志，预算 3 → 用尽
    for (let i = 0; i < 3; i++) {
      await repo.saveLlmLog({ purpose: 'test', input: {}, ok: true });
    }
    let called = false;
    const agent: WeeklyAgent = {
      name: 'spy',
      generate: async () => {
        called = true;
        throw new Error('不应被调用');
      },
    };
    const r = await runSimWeeklyAI({ repo, agent, weekEnd: '2020-08-10', llmBudgetPerDay: 3 });
    expect(called).toBe(false);
    expect(r.budgetExceeded).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.narrative).toBeNull();
    expect(await repo.countLlmCallsToday()).toBe(3);
  });

  it('正常路径（scripted agent）→ 叙事 + 提案草案；active 规则不动（人批准前永不生效）', async () => {
    const repo = await setup();
    await seedWeeklyData(repo);
    const before = (await repo.getActiveRule())!;
    const r = await runSimWeeklyAI({ repo, agent: createScriptedWeeklyAgent(), weekEnd: '2020-08-10' });
    expect(r.narrativeSource).toBe('llm');
    expect(r.narrative).not.toBeNull();
    expect(r.proposals.length).toBeGreaterThanOrEqual(1);
    // 提案草案 rule propose 兼容：完整 config 过 parseRuleConfig
    for (const p of r.proposals) {
      expect(p.basis.length).toBeGreaterThan(0);
      expect(parseRuleConfig(p.config).ok).toBe(true);
      expect(p.config.grading.strongMin).toBe(before.grading.strongMin + 2);
    }
    // 红线：active 未变
    expect((await repo.getActiveRule())!.grading.strongMin).toBe(before.grading.strongMin);
    // LLM 调用入审计
    expect(await repo.countLlmCallsToday()).toBe(1);
  });

  it('agent 抛错 → 落失败审计日志 + 降级零 LLM 骨架', async () => {
    const repo = await setup();
    await seedWeeklyData(repo);
    const agent: WeeklyAgent = {
      name: 'boom',
      generate: async () => {
        throw new Error('LLM 挂了');
      },
    };
    const r = await runSimWeeklyAI({ repo, agent, weekEnd: '2020-08-10' });
    expect(r.narrative).toBeNull();
    expect(r.degraded).toBe(true);
    expect(r.budgetExceeded).toBe(false);
    expect(await repo.countLlmCallsToday()).toBe(1); // 失败也留审计
    expect(r.report.comparison.current.showCnt).toBe(50000); // 骨架不受影响
  });

  it('无 active 规则 → 报错（AI 规则建议需要规则基准）', async () => {
    const repo = new MemoryRepo();
    await seedWeeklyData(repo);
    await expect(runSimWeeklyAI({ repo, agent: null, weekEnd: '2020-08-10' })).rejects.toThrow('active 规则');
  });

  it('agent 返回带越权 patch 的建议 → 防御纵深丢弃，提案为空', async () => {
    const repo = await setup();
    await seedWeeklyData(repo);
    const malicious: WeeklyAgentResult = {
      narrative: { summary: '本周曝光持平但完播率环比下滑 10 个百分点，有量内容留不住人，建议复盘开头节奏与题材匹配度，并人工确认。' },
      ruleSuggestions: [
        {
          basis: '试图越权改满分结构的建议',
          expectedEffect: '越权',
          patches: [{ path: 'scoring.commission', value: 99, reason: '越权' }],
        },
      ],
      degraded: false,
      audit: { purpose: 'weekly-narrative:report', model: 'mock', skill: 'weekly-narrative@1', input: {}, output: {} },
    };
    const agent: WeeklyAgent = { name: 'mock', generate: async () => malicious };
    const r = await runSimWeeklyAI({ repo, agent, weekEnd: '2020-08-10' });
    expect(r.narrative).not.toBeNull();
    expect(r.proposals).toHaveLength(0); // 越权建议合成不出合法 config
  });
});
