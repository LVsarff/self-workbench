/**
 * Skill 评测集 runner（npm run eval）：改提示词 / 换模型 / 改 schema 后必跑。
 *
 * 用法：
 *   npm run eval                 跑全部 5 skill × 2 用例（真 LLM，约 10 次调用，不占生产日预算）
 *   npm run eval -- --skill research    只跑单个 skill
 *
 * 无 OPENAI_API_KEY → 打印提示并正常退出（不炸 CI）；
 * 有 key 且有用例失败 → exit 1（改提示词引入回归时立即可见）；
 * --skill 值无效 / 过滤后 0 用例（打错 skill 名）→ exit 1（不许虚假绿、不许静默烧钱跑全部）。
 * 评测不落 llm_call_logs、不占 GWD_LLM_BUDGET_CALLS_PER_DAY（工程行为，非业务调用）。
 */
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../env.js';
import { runEvals, createAgentBundleFromEnv, EVAL_CASES, type EvalOutcome } from './cases.js';

/**
 * 解析 --skill 参数（纯函数，可测）。
 * 返回：{ skill } 正常；{ } 未传（全跑）；{ error } 传了但值无效（缺失 / 空串 / 是另一个 flag）。
 * 值无效必须报错而不是静默跑全部——评测是真 LLM 调用，静默扩围 = 烧钱。
 */
export function resolveSkillArg(argv: string[]): { skill?: string; error?: string } {
  const eq = argv.find((a) => a.startsWith('--skill='));
  if (eq !== undefined) {
    const v = eq.slice('--skill='.length);
    if (v.length === 0 || v.startsWith('-')) return { error: `--skill 需要一个有效的 skill 名（得到 "${v}"）` };
    return { skill: v };
  }
  const idx = argv.indexOf('--skill');
  if (idx === -1) return {};
  const v = argv[idx + 1];
  if (v === undefined || v.length === 0 || v.startsWith('-')) return { error: '--skill 需要一个 skill 名作为值（如 --skill research）' };
  return { skill: v };
}

/**
 * 空结果守卫（纯函数，可测）：过滤后 0 个用例 = 配置错误，必须当失败处理。
 * 「0/0 通过」是虚假绿——会掩盖打错 skill 名导致的整段跳过。
 * 返回 null 放行；返回错误信息则调用方应 exit 1。
 */
export function assertNonEmpty(outcomes: EvalOutcome[], skill?: string): string | null {
  if (outcomes.length > 0) return null;
  const available = [...new Set(EVAL_CASES.map((c) => c.skill))].sort().join(' | ');
  return skill
    ? `没有 skill 叫 "${skill}" 的评测用例（可用: ${available}）`
    : `评测用例集为空（可用 skill: ${available}）`;
}

function printReport(outcomes: EvalOutcome[]): void {
  const bySkill = new Map<string, EvalOutcome[]>();
  for (const o of outcomes) {
    const list = bySkill.get(o.skill) ?? [];
    list.push(o);
    bySkill.set(o.skill, list);
  }
  console.log('\n🧪 Skill 评测集（改提示必跑 · 断言契约不断言文案）\n');
  for (const [skill, list] of bySkill) {
    console.log(`—— ${skill} ——`);
    for (const o of list) {
      const mark = o.pass ? '✓' : '✗';
      console.log(`  ${mark} ${o.name}`);
      for (const err of o.errors) console.log(`      · ${err}`);
    }
  }
  const failed = outcomes.filter((o) => !o.pass);
  const anchors = outcomes.every((o) => o.anchorsRun);
  console.log(`\n合计: ${outcomes.length - failed.length}/${outcomes.length} 通过${anchors ? '' : '（scripted 模式：方向锚点未执行）'}`);
  if (failed.length > 0) {
    console.log('失败用例即回归信号：对照任务包（SKILL.md）与 schema 检查本次改动。\n');
  }
}

async function main(): Promise<void> {
  loadEnv();
  const { skill, error } = resolveSkillArg(process.argv);
  if (error) {
    console.error(`✗ ${error}`);
    process.exit(1);
  }
  // skill 存在性预检（fail fast：不依赖 key / 环境，打错名立刻报错，不留到配了 key 才发现）
  if (skill !== undefined && !EVAL_CASES.some((c) => c.skill === skill)) {
    console.error(`✗ ${assertNonEmpty([], skill)}`);
    process.exit(1);
  }
  const agents = createAgentBundleFromEnv();
  if (!agents) {
    console.log('⏭ 评测跳过：未配置 OPENAI_API_KEY（评测集需要真 LLM；改提示词后请配置 key 跑一遍 npm run eval）');
    return;
  }
  const outcomes = await runEvals(agents, { skill, real: true });
  const empty = assertNonEmpty(outcomes, skill);
  if (empty) {
    console.error(`✗ ${empty}`);
    process.exit(1);
  }
  printReport(outcomes);
  if (outcomes.some((o) => !o.pass)) process.exit(1);
}

// 入口守卫：作为模块被 import（测试）时不执行 main，只有直接运行（npm run eval）才执行。
const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
