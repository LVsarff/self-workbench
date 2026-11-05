/**
 * 评测集自身测试（零 LLM 消耗）：用 scripted agent 验证用例与断言逻辑有效。
 * scripted 模式只跑硬断言（方向锚点跳过——scripted 行为是演示性的，不代表模型能力）；
 * 真 LLM 的评测走 npm run eval（改提示必跑）。
 */
import { describe, expect, it } from 'vitest';
import { createScriptedReasonAgent } from '../agent/reason-agent.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { createScriptedContentReviewer } from '../agent/content-reviewer.js';
import { createScriptedGradeAgent } from '../agent/grade-agent.js';
import { createScriptedResearchAgent } from '../agent/research-agent.js';
import { EVAL_CASES, runEvals, createAgentBundleFromEnv, type AgentBundle } from './cases.js';

function scriptedBundle(): AgentBundle {
  return {
    reason: createScriptedReasonAgent(),
    content: createScriptedContentAgent(),
    review: createScriptedContentReviewer(),
    grade: createScriptedGradeAgent(),
    research: createScriptedResearchAgent(),
  };
}

describe('评测集：用例覆盖与断言逻辑（scripted，零 LLM）', () => {
  it('5 个 skill × 2 用例 = 10 个，skill 名与实现一一对应', () => {
    expect(EVAL_CASES).toHaveLength(10);
    const skills = new Set(EVAL_CASES.map((c) => c.skill));
    expect([...skills].sort()).toEqual(['content-gen', 'content-review', 'daily-scan', 'grade-suggest', 'research']);
  });

  it('scripted 全跑：硬断言全过（锚点跳过不失败）', async () => {
    const outcomes = await runEvals(scriptedBundle(), { real: false });
    expect(outcomes).toHaveLength(10);
    const failed = outcomes.filter((o) => !o.pass);
    expect(failed).toEqual([]); // 任何 scripted 失败 = 用例或断言自身写错了
    expect(outcomes.every((o) => o.anchorsRun)).toBe(false); // scripted 不跑锚点
  });

  it('skill 过滤：只跑 research → 恰好 2 个用例', async () => {
    const outcomes = await runEvals(scriptedBundle(), { skill: 'research', real: false });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.skill === 'research')).toBe(true);
  });

  it('断言器真的在抓错：注入坏 agent（恒降级）→ 对应用例失败且带错误信息', async () => {
    const bad = scriptedBundle();
    bad.reason = {
      name: 'bad',
      async generate() {
        return { reasons: [], submitted: false, degraded: true, audit: { purpose: 'x', model: 'x', skill: 'x', input: null, output: null } };
      },
    };
    const outcomes = await runEvals(bad, { skill: 'daily-scan', real: false });
    expect(outcomes).toHaveLength(2);
    const first = outcomes.find((o) => o.name.includes('Top3'))!;
    expect(first.pass).toBe(false);
    expect(first.errors.length).toBeGreaterThanOrEqual(1); // 失败原因被收集（不是只给布尔）
    expect(first.errors[0]).toContain('至少产出 1 条理由');
  });
});

describe('评测集：环境构造', () => {
  it('无 OPENAI_API_KEY → bundle 为 null（runner 提示跳过，不炸 CI）', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(createAgentBundleFromEnv()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});
