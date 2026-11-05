/**
 * 评测集 runner 对抗性测试：空输入 / 乱格式 / 恶意极端 / 越界操作。
 *
 * 评测集的攻击面与业务管道不同：它不接业务库（runEvals 签名层面就无 repo 依赖），
 * 风险集中在 CLI 参数与「结果可信度」：
 * - 打错 skill 名 → 0 用例被跑 → 不能假装「0/0 通过」（虚假绿会掩盖回归）
 * - --skill 值缺失 / 为空 / 是另一个 flag → 不能静默跑全部（烧 10 次真调用）
 */
import { describe, expect, it } from 'vitest';
import { createScriptedReasonAgent } from '../agent/reason-agent.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { createScriptedContentReviewer } from '../agent/content-reviewer.js';
import { createScriptedGradeAgent } from '../agent/grade-agent.js';
import { createScriptedResearchAgent } from '../agent/research-agent.js';
import { runEvals, type AgentBundle } from '../eval/cases.js';
import { assertNonEmpty, resolveSkillArg } from '../eval/run-evals.js';

function scriptedBundle(): AgentBundle {
  return {
    reason: createScriptedReasonAgent(),
    content: createScriptedContentAgent(),
    review: createScriptedContentReviewer(),
    grade: createScriptedGradeAgent(),
    research: createScriptedResearchAgent(),
  };
}

describe('评测对抗：CLI 参数（空/乱格式）', () => {
  it('未传 --skill → 全跑（skill 与 error 均为 undefined）', () => {
    expect(resolveSkillArg(['node', 'run-evals.ts'])).toEqual({});
  });

  it('--skill research 与 --skill=research → 均正确解析', () => {
    expect(resolveSkillArg(['--skill', 'research'])).toEqual({ skill: 'research' });
    expect(resolveSkillArg(['--skill=research'])).toEqual({ skill: 'research' });
  });

  it('--skill 无值（末尾截断）→ 必须报错，不许静默跑全部（烧 10 次真调用）', () => {
    expect(resolveSkillArg(['--skill']).error).toMatch(/--skill/);
  });

  it('--skill= 空值 → 必须报错', () => {
    expect(resolveSkillArg(['--skill=']).error).toMatch(/--skill/);
  });

  it('--skill 后跟另一个 flag（--skill --force）→ 必须报错（flag 不是 skill 名）', () => {
    expect(resolveSkillArg(['--skill', '--force']).error).toMatch(/--skill/);
  });

  it('超长 / 控制字符的 skill 名 → 解析为 skill 但过滤必然 0 命中（交给空结果守卫）', () => {
    const weird = '--skill=' + 'x'.repeat(500) + '\x01';
    expect(resolveSkillArg([weird]).skill?.length).toBeGreaterThan(500);
  });
});

describe('评测对抗：虚假绿守卫', () => {
  it('打错 skill 名（typo）→ runEvals 返回 0 用例，守卫必须把 0 用例当配置错误（错误信息含可用 skill 名）', async () => {
    const outcomes = await runEvals(scriptedBundle(), { skill: 'reserch', real: false }); // 打错字
    expect(outcomes).toHaveLength(0); // 过滤行为本身正确
    const err = assertNonEmpty(outcomes, 'reserch');
    expect(err).toMatch(/reserch/);
    expect(err).toMatch(/research/); // 提示可用项，帮用户发现拼写错误
  });

  it('全量跑 → 守卫放行（返回 null）', async () => {
    const outcomes = await runEvals(scriptedBundle(), { real: false });
    expect(outcomes).toHaveLength(10);
    expect(assertNonEmpty(outcomes)).toBeNull();
  });

  it('合法 skill 过滤 → 守卫放行', async () => {
    const outcomes = await runEvals(scriptedBundle(), { skill: 'grade-suggest', real: false });
    expect(outcomes).toHaveLength(2);
    expect(assertNonEmpty(outcomes, 'grade-suggest')).toBeNull();
  });
});

describe('评测对抗：越界操作（零业务副作用）', () => {
  it('runEvals 全程零触碰业务库：签名不接 repo，跑完不产生任何持久化（设计性防御，锚定不变）', async () => {
    // runEvals(agents, opts) 的参数类型里没有 repo —— 评测在类型层面就不可能写业务表。
    // 这里锚定：scripted 全跑 10 用例，无异常无降级路径副作用。
    const outcomes = await runEvals(scriptedBundle(), { real: false });
    expect(outcomes).toHaveLength(10);
    expect(outcomes.every((o) => o.pass)).toBe(true);
  });
});
