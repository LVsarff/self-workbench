/**
 * gwd CLI —— 编排入口（单Agent方案 §4.3）。
 * 命令一览：
 *   gwd migrate                          应用数据库迁移
 *   gwd rule init|show|list|apply|rollback  规则版本管理（人批准门）
 *   gwd import-candidates <csv> [--date]   导入人工候选表格（MVP 数据入口）
 *   gwd daily-scan [--date] [--no-agent]   跑筛品流水线（打分→排序→理由→提交）
 *   gwd list [--date]                      查看今日候选清单
 *   gwd select <id...> [--date] [--note]   勾选门：勾选要做的品
 *   gwd demo                               无 DB/无 API key 一键体验全流程
 */
import { Command } from 'commander';
import { loadEnv } from './env.js';
import { RULE_V1, parseRuleConfig } from './core/rule-config.js';
import { GRADE_LABEL, type DailyList } from './core/types.js';
import { MemoryRepo } from './db/memory-repo.js';
import { PgRepo } from './db/pg-repo.js';
import { migrate } from './db/migrate.js';
import type { Repo } from './db/repo.js';
import { readCandidatesFile } from './pipeline/csv-import.js';
import { runDailyScan } from './pipeline/daily-scan.js';
import { selectProducts } from './pipeline/select.js';
import { createReasonAgentFromEnv, createScriptedReasonAgent } from './agent/reason-agent.js';
import { todayShanghai } from './util.js';
import { readFileSync } from 'node:fs';

loadEnv();

function createRepo(mode?: string): Repo {
  const db = mode ?? process.env.GWD_DB ?? 'pg';
  if (db === 'memory') return new MemoryRepo();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('未配置 DATABASE_URL（或用 --db memory 体验）');
  return new PgRepo(url);
}

function printList(list: DailyList): void {
  console.log(`\n📅 ${list.date} 候选清单（run ${list.runId.slice(0, 8)}… 规则 v${list.ruleVersion} 状态 ${list.status}）\n`);
  const ranked = list.items.filter((i) => i.gatePassed && i.complete);
  const others = list.items.filter((i) => !(i.gatePassed && i.complete));
  if (ranked.length > 0) {
    console.log('—— 排行榜（门槛通过 + 主观三维齐全）——');
    ranked.forEach((i, idx) => {
      const mark = i.selected ? '✅' : '  ';
      console.log(`${mark} ${String(idx + 1).padStart(2)}. [${GRADE_LABEL[i.grade!]}] ${String(i.total).padStart(3)}分  ${i.externalId}  ${i.title.slice(0, 18)}`);
      console.log(`      佣金${i.commissionRate ?? '-'}%  销量${i.sales30d ?? '-'}  好评${i.reviewRate ?? '-'}%  理由(${i.reasonSource}): ${(i.reason ?? '').slice(0, 50)}`);
    });
  }
  if (others.length > 0) {
    console.log('\n—— 未入榜（门槛未过/待评）——');
    others.forEach((i) => {
      const mark = i.selected ? '✅' : '  ';
      console.log(`${mark} ${String(i.total).padStart(3)}分  ${i.externalId}  ${i.title.slice(0, 18)}  ${i.flags.join('；') || '门槛未过'}`);
    });
  }
  console.log(`\n勾选: npm run gwd -- select <商品ID...>（可多个）`);
}

const program = new Command();
program.name('gwd').description('个人 AI 带货工作台（MVP：单 Agent 选品中心）').version('0.1.0');

program
  .command('migrate')
  .description('应用数据库迁移')
  .action(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('未配置 DATABASE_URL');
    const applied = await migrate(url);
    console.log(applied.length > 0 ? `已应用迁移: ${applied.join(', ')}` : '数据库已是最新');
  });

const rule = program.command('rule').description('规则版本管理（AI 只建议，人批准后生效）');

rule
  .command('init')
  .description('初始化规则 v1（对应 PRD A.1/A.2）')
  .action(async () => {
    const repo = createRepo() as PgRepo;
    const existing = await repo.getActiveRule();
    if (existing) {
      console.log(`已有 active 规则 v${existing.version}，如需覆盖请用 rule apply`);
      await repo.close();
      return;
    }
    const v = await repo.applyRuleVersion(RULE_V1, { reason: '初始化：PRD A.1/A.2 判据', approvedBy: 'human-cli' });
    console.log(`已初始化规则 v${v}`);
    await repo.close();
  });

rule
  .command('show')
  .description('查看当前 active 规则')
  .action(async () => {
    const repo = createRepo() as PgRepo;
    const cfg = await repo.getActiveRule();
    if (!cfg) {
      console.log('没有 active 规则，先执行 gwd rule init');
    } else {
      console.log(JSON.stringify(cfg, null, 2));
    }
    await repo.close();
  });

rule
  .command('list')
  .description('查看规则版本链')
  .action(async () => {
    const repo = createRepo() as PgRepo;
    const versions = await repo.listRuleVersions();
    for (const v of versions) {
      console.log(`v${String(v.version).padEnd(4)} [${v.status.padEnd(10)}] ${v.changeReason ?? ''} (${v.createdAt.slice(0, 19)})`);
    }
    await repo.close();
  });

rule
  .command('apply <file>')
  .description('应用新规则版本（JSON 文件；version 可省略，自动递增）—— 人批准门')
  .requiredOption('--reason <reason>', '变更理由（审计必填）')
  .action(async (file: string, opts: { reason: string }) => {
    const repo = createRepo() as PgRepo;
    const current = await repo.getActiveRule();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (current) raw.version = current.version; // applyRuleVersion 内部自动 +1
    const parsed = parseRuleConfig(raw);
    if (!parsed.ok) {
      console.error('规则校验失败:\n' + parsed.errors.map((e) => `  - ${e}`).join('\n'));
      process.exitCode = 1;
      await repo.close();
      return;
    }
    const v = await repo.applyRuleVersion(parsed.config, { reason: opts.reason, approvedBy: 'human-cli' });
    console.log(`已生效规则 v${v}（前版本已 superseded；回滚: gwd rule rollback）`);
    await repo.close();
  });

rule
  .command('rollback')
  .description('回滚到上一版本')
  .action(async () => {
    const repo = createRepo() as PgRepo;
    const { from, to } = await repo.rollbackRule();
    console.log(`已回滚: v${from} → v${to}`);
    await repo.close();
  });

program
  .command('import-candidates <file>')
  .description('导入人工维护的候选 CSV（支持中文表头）')
  .option('--date <date>', '批次日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (file: string, opts: { date?: string; db?: string }) => {
    const date = opts.date ?? todayShanghai();
    const repo = createRepo(opts.db);
    const result = readCandidatesFile(file);
    for (const e of result.errors) console.warn(`  ⚠ 第 ${e.line} 行跳过: ${e.message}`);
    const upsert = await repo.upsertSnapshots(result.rows, date);
    await repo.recordImportBatch({
      batchDate: date,
      sourceFile: file,
      rowCount: result.stats.total,
      validCount: result.stats.valid,
      skippedCount: result.stats.skipped,
      notes: { errors: result.errors },
    });
    console.log(`导入 ${date}: 共 ${result.stats.total} 行，有效 ${result.stats.valid}（新增 ${upsert.inserted} / 更新 ${upsert.updated}），跳过 ${result.stats.skipped}`);
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('daily-scan')
  .description('跑筛品流水线：打分 → 排序 → Agent 理由 → 提交清单')
  .option('--date <date>', '批次日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .option('--no-agent', '跳过 LLM，直接用模板理由（LLM 不可用时的设计内路径）')
  .action(async (opts: { date?: string; db?: string; agent?: boolean }) => {
    const repo = createRepo(opts.db);
    const agent = opts.agent === false ? null : createReasonAgentFromEnv();
    if (opts.agent !== false && !agent) console.log('ℹ 未配置 OPENAI_API_KEY，使用模板理由（流水线照常完成）');
    const result = await runDailyScan({ repo, date: opts.date, agent });
    console.log(`\ndaily-scan 完成: run ${result.runId.slice(0, 8)}…`);
    console.log(`  打分 ${result.scoredCount} 个（入榜 ${result.topCount}，待评 ${result.pendingCount}，门槛淘汰 ${result.gateFailedCount}，黑名单 ${result.blacklistedCount}）`);
    console.log(`  理由来源: ${result.reasonSource}${result.degraded ? '（降级）' : ''}`);
    const list = await repo.getDailyList(result.date);
    if (list) printList(list);
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('list')
  .description('查看候选清单')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { date?: string; db?: string }) => {
    const date = opts.date ?? todayShanghai();
    const repo = createRepo(opts.db);
    const list = await repo.getDailyList(date);
    if (!list) {
      console.log(`${date} 没有清单，先执行 gwd daily-scan`);
    } else {
      printList(list);
    }
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('select <ids...>')
  .description('勾选门：勾选要做的品（可多个，空格分隔）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--note <note>', '备注（写入决策流水）')
  .option('--db <mode>', 'pg | memory')
  .action(async (ids: string[], opts: { date?: string; note?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    const result = await selectProducts({ repo, date: opts.date, externalIds: ids, note: opts.note });
    if (result.selected.length > 0) console.log(`✅ 已勾选 ${result.date}: ${result.selected.join(', ')}`);
    if (result.alreadySelected.length > 0) console.log(`↩ 已勾选过（幂等跳过）: ${result.alreadySelected.join(', ')}`);
    console.log(`决策已 append-only 落库（run ${result.runId.slice(0, 8)}…）→ 成为内容生成 run 的输入`);
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('demo')
  .description('无 DB / 无 API key 一键体验全流程（内存仓储 + 脚本化 Agent）')
  .action(async () => {
    const repo = new MemoryRepo();
    const date = todayShanghai();
    console.log('=== gwd demo：内存模式全流程演示 ===\n');
    console.log('[1] 初始化规则 v1');
    await repo.applyRuleVersion(RULE_V1, { reason: 'demo 初始化', approvedBy: 'human' });
    console.log('[2] 导入示例 CSV（templates/candidates-example.csv）');
    const csv = readCandidatesFile('templates/candidates-example.csv');
    for (const e of csv.errors) console.warn(`  ⚠ 第 ${e.line} 行跳过: ${e.message}`);
    await repo.upsertSnapshots(csv.rows, date);
    console.log(`    有效 ${csv.rows.length} 行，跳过 ${csv.errors.length} 行`);
    console.log('[3] daily-scan（脚本化 Agent 生成理由）');
    const result = await runDailyScan({ repo, date, agent: createScriptedReasonAgent() });
    console.log(`    打分 ${result.scoredCount}，入榜 ${result.topCount}，门槛淘汰 ${result.gateFailedCount}，理由 ${result.reasonSource}\n`);
    const list = (await repo.getDailyList(date))!;
    printList(list);
    const first = list.items.find((i) => i.gatePassed && i.complete && !i.selected);
    if (first) {
      console.log(`\n[4] 勾选门演示：勾选 ${first.externalId}`);
      const sel = await selectProducts({ repo, date, externalIds: [first.externalId], note: 'demo 勾选' });
      console.log(`    已落决策流水: ${sel.selected.join(', ')}（append-only，审计可回溯）`);
    }
    console.log('\n=== demo 结束。真实使用：docker compose up -d → gwd migrate → gwd rule init → 每日 import-candidates + daily-scan ===');
  });

program.parseAsync().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
