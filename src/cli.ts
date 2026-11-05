/**
 * gwd CLI —— 编排入口（单Agent方案 §4.3）。
 * 命令一览：
 *   gwd migrate                          应用数据库迁移
 *   gwd rule init|show|list|apply|rollback  规则版本管理（人批准门）
 *   gwd import-candidates <csv> [--date]   导入人工候选表格（MVP 数据入口）
 *   gwd daily-scan [--date] [--no-agent]   跑筛品流水线（打分→排序→理由→提交）
 *   gwd list [--date]                      查看今日候选清单
 *   gwd grade-suggest [--date]             待评品三维打档建议（AI 建议，人可改，不落库）
 *   gwd select <id...> [--date] [--note]   勾选门：勾选要做的品
 *   gwd content-gen [--date] [--force]     内容工坊（B1）：双版草稿 + 自检修订循环 + L2 审查
 *   gwd contents [--date]                  查看内容草稿
 *   gwd research <id> [--file <txt>] [--force]  深度调研摘要（V2）：抄录原文 → 舆情/风险/素材点，人终判
 *   gwd confirm <id> <platform> [--date]   确认门（门③）：5 项清单逐项人工确认
 *   gwd discard <id> <platform> [--date]   弃用草稿（记入决策流水）
 *   gwd publish-sync [--date]              发布队列同步：已确认内容 → 待发布（B2）
 *   gwd publish-list [--date]              待发布队列 + 发布台账（建议时段/超时警示）
 *   gwd published <id> <platform> --url    人工发布后回填台账（链接/时间/AI 标注）
 *   gwd sim-import [--dir] [--limit]       导入 KuaiRec 模拟表现数据（B3 第一批，幂等）
 *   gwd sim-dashboard [--author]           模拟数据账号看板（日趋势/Top 内容/异常日）
 *   gwd real-import <csv> [--limit]        导入本人账号真实表现数据（P0，source=manual，幂等）
 *   gwd real-dashboard [--author]          真实数据账号看板（口径同模拟看板，双源隔离）
 *   gwd demo                               无 DB/无 API key 一键体验全流程
 */
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from './env.js';
import { RULE_V1, parseRuleConfig } from './core/rule-config.js';
import { GRADE_LABEL, PLATFORM_LABEL, type DailyList, type DouyinScript, type Platform, type XiaohongshuNote } from './core/types.js';
import { MemoryRepo } from './db/memory-repo.js';
import { PgRepo } from './db/pg-repo.js';
import { migrate } from './db/migrate.js';
import type { ContentDraftRow, Repo } from './db/repo.js';
import { readCandidatesFile } from './pipeline/csv-import.js';
import { runDailyScan } from './pipeline/daily-scan.js';
import { runContentGen } from './pipeline/content-gen.js';
import { confirmContentDraft, discardContentDraft, GATE3_CHECKLIST } from './pipeline/content-confirm.js';
import { listPublishQueue, recordPublish, syncPublishQueue, type PublishQueueItem } from './pipeline/publish.js';
import { isoToShanghaiDisplay } from './core/publish-slots.js';
import { selectProducts } from './pipeline/select.js';
import { createReasonAgentFromEnv, createScriptedReasonAgent } from './agent/reason-agent.js';
import { createContentAgentFromEnv, createScriptedContentAgent } from './agent/content-agent.js';
import { createContentReviewerFromEnv, createScriptedContentReviewer } from './agent/content-reviewer.js';
import { createGradeAgentFromEnv, createScriptedGradeAgent } from './agent/grade-agent.js';
import { runGradeSuggest } from './pipeline/grade-suggest.js';
import { createResearchAgentFromEnv, createScriptedResearchAgent } from './agent/research-agent.js';
import { runResearch, showResearch } from './pipeline/research.js';
import { runSimImport } from './pipeline/sim-import.js';
import { runSimDashboard } from './pipeline/sim-dashboard.js';
import { runSimPlayImport } from './pipeline/sim-play-import.js';
import { runSimContent } from './pipeline/sim-content.js';
import { runSimWeekly } from './pipeline/sim-weekly.js';
import { runSimWeeklyAI } from './pipeline/sim-weekly-ai.js';
import { createWeeklyAgentFromEnv } from './agent/weekly-agent.js';
import { runRealImport } from './pipeline/real-import.js';
import { runRealDashboard } from './pipeline/real-dashboard.js';
import { runExport } from './pipeline/export.js';
import { todayShanghai } from './util.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

const DRAFT_STATUS_LABEL: Record<ContentDraftRow['status'], string> = {
  draft: '📝 草稿',
  needs_manual: '✋ 需人工',
  confirmed: '✅ 已确认',
  discarded: '🗑 已弃用',
};

function printDrafts(drafts: ContentDraftRow[]): void {
  console.log(`\n✍ 内容草稿（${drafts.length} 条）`);
  const byProduct = new Map<string, ContentDraftRow[]>();
  for (const d of drafts) {
    const list = byProduct.get(d.productId) ?? [];
    list.push(d);
    byProduct.set(d.productId, list);
  }
  for (const list of byProduct.values()) {
    const first = list[0]!;
    console.log(`\n📦 ${first.externalId}  ${first.title.slice(0, 24)}`);
    for (const d of list) {
      console.log(`  ${DRAFT_STATUS_LABEL[d.status]}  [${PLATFORM_LABEL[d.platform]}]${d.revisionCount > 0 ? `（经 ${d.revisionCount} 轮修订）` : ''}`);
      if (d.bannedHits.length > 0) console.log(`     ⚠ 词表命中: ${d.bannedHits.join('、')}（硬拦截，确认前必须改写）`);
      if (d.duplicates.length > 0) {
        console.log(`     ⚠ 与近期草稿相似: ${d.duplicates.map((h) => `${h.batchDate}「${h.title}」${h.similarity.toFixed(2)}`).join('、')}`);
      }
      if (d.review) {
        if (d.review.pass === false) {
          console.log(`     ⚠ LLM 审查提示（仅提示，门③ 终判）: ${d.review.risks.map((r) => `[${r.type}] ${r.detail}`).join('；')}`);
        } else if (d.review.pass === null) {
          console.log(`     ℹ L2 审查跳过: ${d.review.skippedReason ?? '未知原因'}`);
        } else {
          console.log(`     ✓ L2 审查通过（${d.review.model}）`);
        }
      }
      if (d.status === 'needs_manual') {
        console.log(`     原因: ${d.note ?? 'LLM 未产出'}`);
      } else if (d.note) {
        console.log(`     备注: ${d.note}`);
      }
      if (d.content) {
        if (d.platform === 'xiaohongshu') {
          const n = d.content as XiaohongshuNote;
          console.log(`     标题: ${n.title}`);
          console.log(`     正文: ${n.body.slice(0, 60)}…（${n.body.length} 字）`);
          console.log(`     标签: ${n.tags.join(' / ')}${n.coverIdea ? `  封面: ${n.coverIdea}` : ''}`);
        } else {
          const s = d.content as DouyinScript;
          console.log(`     钩子: ${s.hook}`);
          console.log(`     卖点: ${s.points.join('；')}`);
          console.log(`     CTA: ${s.cta}`);
        }
      }
    }
  }
  console.log(`\n门③: gwd confirm <商品ID> <xiaohongshu|douyin>（5 项清单确认）· gwd discard <商品ID> <平台>（弃用）`);
}

/** 平台参数解析（支持 xiaohongshu/xhs/小红书 与 douyin/dy/抖音） */
function parsePlatform(raw: string): Platform {
  const v = raw.trim().toLowerCase();
  if (v === 'xiaohongshu' || v === 'xhs' || v === '小红书') return 'xiaohongshu';
  if (v === 'douyin' || v === 'dy' || v === '抖音') return 'douyin';
  throw new Error(`无法识别平台 "${raw}"（可用: xiaohongshu | douyin）`);
}

/** 发布队列 + 发布台账展示（门④：只提醒不代发，发布后人工回填） */
function printPublishQueue(items: PublishQueueItem[]): void {
  const pending = items.filter((i) => i.record.status === 'pending');
  const published = items.filter((i) => i.record.status === 'published');
  console.log(`\n🚀 发布队列（待发布 ${pending.length} · 已发布 ${published.length}）`);
  if (pending.length > 0) {
    console.log('—— 待发布（按建议时段人工发布，门④ 红线：系统不代发）——');
    pending.forEach((i, idx) => {
      const overdue = i.overdue ? '  ⚠ 超 24h 未发布，尽快处理或 discard 重做' : '';
      console.log(`  ${String(idx + 1).padStart(2)}. ${i.draft.externalId}  [${PLATFORM_LABEL[i.record.platform]}]  建议发布 ${i.suggestedSlots.join(' / ')}${overdue}`);
      if (i.draft.content) {
        const preview =
          i.record.platform === 'xiaohongshu'
            ? `「${(i.draft.content as XiaohongshuNote).title}」`
            : `钩子「${(i.draft.content as DouyinScript).hook}」`;
        console.log(`      ${i.draft.title.slice(0, 24)} ${preview}`);
      } else {
        console.log(`      ${i.draft.title.slice(0, 24)}`);
      }
      console.log(`      发布后回填: gwd published ${i.draft.externalId} ${i.record.platform} --url <链接>`);
    });
  }
  if (published.length > 0) {
    console.log('—— 已发布台账（V3 归因事实表）——');
    published.forEach((i) => {
      const label = i.record.aiLabeled ? '已标注' : '未标注 ⚠';
      console.log(`  ✅ ${i.draft.externalId}  [${PLATFORM_LABEL[i.record.platform]}]  ${isoToShanghaiDisplay(i.record.publishedAt!)}  ${label}`);
      console.log(`      ${i.record.url}`);
    });
  }
  if (pending.length > 0) {
    console.log(`\n发布: 复制内容 → 平台发布并勾选「AI 生成」标注 → gwd published 回填`);
  }
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

// —— 规则提案（模块⑤ 回写闭环：建议 → 人批准 → 版本化生效 → 可回滚）——
rule
  .command('propose <file>')
  .description('从 JSON 文件创建规则提案 { basis, expectedEffect?, config }（只登记，不生效）')
  .action(async (file: string) => {
    const repo = createRepo() as PgRepo;
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as { basis?: string; expectedEffect?: string; config?: unknown };
      if (!json.basis || !json.config) {
        throw new Error('提案文件需要 basis（依据）与 config（完整规则配置）两个字段');
      }
      const row = await repo.createRuleProposal({ basis: json.basis, expectedEffect: json.expectedEffect ?? null, config: json.config as never });
      console.log(`提案已登记: ${row.id}（pending，等待人工批准）`);
      console.log(`  依据: ${row.basis}`);
      if (row.expectedEffect) console.log(`  预期效果: ${row.expectedEffect}`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
    await repo.close();
  });

rule
  .command('proposals')
  .description('提案列表（建议 → 人批准 → 版本化生效 → 可回滚）')
  .action(async () => {
    const repo = createRepo() as PgRepo;
    const rows = await repo.listRuleProposals();
    if (rows.length === 0) {
      console.log('暂无提案');
    }
    for (const r of rows) {
      const mark = r.status === 'pending' ? '⏳' : r.status === 'approved' ? '✅' : '❌';
      console.log(`${mark} ${r.id}  [${r.status}]  ${r.basis}`);
      if (r.expectedEffect) console.log(`    预期效果: ${r.expectedEffect}`);
      if (r.resultingVersion != null) console.log(`    生效版本: v${r.resultingVersion}（可 gwd rule rollback 回滚）`);
      console.log(`    创建: ${r.createdAt}${r.decidedBy ? ` · 决策: ${r.decidedBy} @ ${r.decidedAt}` : ''}`);
    }
    await repo.close();
  });

rule
  .command('approve <id>')
  .description('批准提案 → 重新校验 → 版本链生效（门⑤：系统永不自行生效）')
  .action(async (id: string) => {
    const repo = createRepo() as PgRepo;
    try {
      const row = await repo.decideRuleProposal(id, { action: 'approve', decidedBy: 'human-cli' });
      console.log(`已批准提案 ${row.id}，生效为规则 v${row.resultingVersion}（可 gwd rule rollback 回滚）`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
    await repo.close();
  });

rule
  .command('reject <id>')
  .description('否决提案（留档，active 规则不动）')
  .action(async (id: string) => {
    const repo = createRepo() as PgRepo;
    try {
      const row = await repo.decideRuleProposal(id, { action: 'reject', decidedBy: 'human-cli' });
      console.log(`已否决提案 ${row.id}（留档，active 规则未变）`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
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
  .command('export <what>')
  .description('导出 CSV（daily=候选清单 / publish=发布台账；导出统一消毒，Excel 可安全打开）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--out <file>', '输出文件路径（缺省打印到终端）')
  .option('--db <mode>', 'pg | memory')
  .action(async (what: string, opts: { date?: string; out?: string; db?: string }) => {
    if (what !== 'daily' && what !== 'publish') {
      console.error('只支持导出 daily（候选清单）或 publish（发布台账）');
      process.exitCode = 1;
      return;
    }
    const repo = createRepo(opts.db);
    try {
      const csv = await runExport({ repo, what, date: opts.date ?? todayShanghai(), out: opts.out });
      if (opts.out) {
        console.log(`已导出到 ${opts.out}`);
      } else {
        console.log(csv);
      }
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('grade-suggest')
  .description('主观三维打档建议：待评品（门槛过 + 三维缺）→ AI 建议档位 + 依据（不落库，人改 CSV）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { date?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    const agent = createGradeAgentFromEnv();
    if (!agent) console.log('ℹ 未配置 OPENAI_API_KEY —— 待评品请人工打档（填进 CSV 后重新导入）');
    const result = await runGradeSuggest({ repo, date: opts.date, agent });
    console.log(`\n📊 主观三维打档建议（${result.date} · 待评 ${result.pendingGrading.length + result.gateFailed.length}）`);
    if (result.pendingGrading.length > 0) {
      console.log('—— 门槛已过 · 建议打档（AI 建议档位，人可改；不落库）——');
      const byId = new Map(result.suggestions.map((s) => [s.externalId, s]));
      result.pendingGrading.forEach((p, idx) => {
        console.log(`  ${String(idx + 1).padStart(2)}. ${p.externalId}  ${p.title.slice(0, 24)}`);
        const s = byId.get(p.externalId);
        if (s) {
          console.log(`      建议: 内容友好 ${s.contentFriendliness} · 竞争缓和 ${s.competition} · 复购扩展 ${s.repurchase}`);
          console.log(`      依据: ${s.rationale}`);
          console.log(`      （引用字段: ${s.citedFields.join(', ')}）`);
        } else {
          console.log('      ⚠ 无建议（LLM 未覆盖或校验丢弃）→ 人工打档');
        }
      });
    }
    if (result.gateFailed.length > 0) {
      console.log('—— 门槛未过 · 无需打档 ——');
      result.gateFailed.forEach((p) => console.log(`  × ${p.externalId}  ${p.title.slice(0, 24)}  ${p.flags.join('；') || '门槛未过'}`));
    }
    if (result.pendingGrading.length === 0 && result.gateFailed.length === 0) {
      console.log('没有待评品（主观三维全部齐全）');
    }
    if (result.degraded) {
      console.log(`⚠ 建议未完整产出${result.budgetExceeded ? '（LLM 日预算已用尽）' : '（LLM 失败或部分缺失）'} → 请人工打档`);
    }
    if (result.pendingGrading.length > 0) {
      console.log('\n确认档位后：填进候选 CSV → gwd import-candidates 重新导入 → gwd daily-scan 重跑（新档位参与排序）');
      console.log('（打档唯一事实源是人工填的 CSV，系统不自动改分）');
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
  .command('content-gen')
  .description('内容工坊（B1）：双版草稿 + L1 自检修订循环（词表/结构/去重）+ L2 LLM 审查（仅提示）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .option('--force', '重新生成已有草稿（已确认的不动，要重做先 discard；已弃用的重跑即重做）')
  .action(async (opts: { date?: string; db?: string; force?: boolean }) => {
    const repo = createRepo(opts.db);
    const agent = createContentAgentFromEnv();
    if (!agent) console.log('ℹ 未配置 OPENAI_API_KEY，草稿将标记 needs_manual（需人工撰写，流水线照常完成）');
    const reviewer = createContentReviewerFromEnv();
    const result = await runContentGen({ repo, date: opts.date, agent, reviewer, force: opts.force });
    console.log(`\ncontent-gen 完成: ${result.date}（run ${result.runId.slice(0, 8)}…）`);
    console.log(
      `  勾选品 ${result.productCount}，生成 ${result.generated}，需人工 ${result.needsManual}，跳过 ${result.skipped}` +
        (result.revisions > 0 ? `，修订 ${result.revisions} 轮` : '') +
        (result.reviewed > 0 ? `，L2 审查 ${result.reviewed}` : '') +
        (result.duplicateHitCount > 0 ? `，疑似重复 ${result.duplicateHitCount} ⚠` : '') +
        (result.bannedHitCount > 0 ? `，词表命中 ${result.bannedHitCount} ⚠` : ''),
    );
    if (result.drafts.length > 0) printDrafts(result.drafts);
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('contents')
  .description('查看内容草稿（按勾选日期）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { date?: string; db?: string }) => {
    const date = opts.date ?? todayShanghai();
    const repo = createRepo(opts.db);
    const drafts = await repo.getContentDrafts(date);
    if (drafts.length === 0) {
      console.log(`${date} 没有内容草稿，先执行 gwd select + gwd content-gen`);
    } else {
      printDrafts(drafts);
    }
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('research <externalId>')
  .description('深度调研摘要（V2）：--file 抄录原文生成/重做摘要（人终判）；不带 --file 查看已有摘要')
  .option('--file <path>', '人工抄录的评论区/商家页原文（txt）')
  .option('--force', '重做已有摘要（原文与摘要同换）')
  .option('--db <mode>', 'pg | memory')
  .action(async (externalId: string, opts: { file?: string; force?: boolean; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      if (!opts.file) {
        const row = await showResearch(repo, externalId);
        if (!row) {
          console.log(`${externalId} 还没有调研摘要；生成：gwd research ${externalId} --file 抄录.txt`);
        } else {
          console.log(`\n🔍 深度调研摘要（${externalId} · ${row.createdAt.slice(0, 10)} 生成，人终判）`);
          console.log(`  舆情倾向: ${row.summary.sentiment}`);
          if (row.summary.highlights.length > 0) {
            console.log('  —— 买家好评集中 ——');
            for (const h of row.summary.highlights) console.log(`  · ${h}`);
          }
          if (row.summary.risks.length > 0) {
            console.log('  —— 风险信号（内容中禁做冲突宣称）——');
            for (const r of row.summary.risks) console.log(`  · ${r}`);
          }
          if (row.summary.materialPoints.length > 0) {
            console.log('  —— 可用素材点（买家真实关注点）——');
            for (const m of row.summary.materialPoints) console.log(`  · ${m}`);
          }
          console.log('\n内容工坊生成该品内容时将自动注入以上参考（gwd content-gen）');
        }
        return;
      }
      const sourceText = readFileSync(opts.file, 'utf8');
      const agent = createResearchAgentFromEnv();
      const result = await runResearch({ repo, externalId, sourceText, agent, force: opts.force });
      console.log(`\n🔍 深度调研摘要已生成（${externalId} · 人终判）`);
      console.log(`  舆情倾向: ${result.summary.sentiment}${result.truncated ? '（原文超长已截断存档）' : ''}`);
      if (result.summary.risks.length > 0) {
        console.log('  —— 风险信号（内容中禁做冲突宣称）——');
        for (const r of result.summary.risks) console.log(`  · ${r}`);
      }
      console.log(`  完整摘要: gwd research ${externalId}；内容工坊生成时自动注入参考`);
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('confirm <externalId> <platform>')
  .description('确认门（门③）：5 项清单逐项人工确认后放行草稿（发布仍为人工动作）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--note <note>', '备注（写入决策流水）')
  .option('--db <mode>', 'pg | memory')
  .option('--yes', '跳过交互，5 项全部视为已确认（脚本/演示用，真实使用请逐项确认）')
  .action(async (externalId: string, platformRaw: string, opts: { date?: string; note?: string; db?: string; yes?: boolean }) => {
    const repo = createRepo(opts.db);
    const platform = parsePlatform(platformRaw);
    const date = opts.date ?? todayShanghai();

    // 先展示草稿与全部自检发现，人看着清单确认
    const drafts = await repo.getContentDrafts(date);
    const draft = drafts.find((d) => d.externalId === externalId && d.platform === platform);
    if (!draft) {
      const owned = drafts.filter((d) => d.externalId === externalId).map((d) => PLATFORM_LABEL[d.platform]);
      throw new Error(
        `${date} 没有找到 ${externalId} 的${PLATFORM_LABEL[platform]}草稿${owned.length > 0 ? `（该商品已有: ${owned.join('、')}）` : '（可用草稿见 gwd contents）'}`,
      );
    }
    printDrafts([draft]);

    let answers: boolean[];
    if (opts.yes) {
      answers = GATE3_CHECKLIST.map(() => true);
      console.log('\n--yes：5 项全部视为已确认（脚本/演示路径）');
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      answers = [];
      console.log('\n门③ 5 项确认清单（逐项 y/n，任一项 n 即拒绝）:');
      try {
        for (let i = 0; i < GATE3_CHECKLIST.length; i += 1) {
          const a = await rl.question(`${i + 1}. ${GATE3_CHECKLIST[i]} (y/n) `);
          answers.push(a.trim().toLowerCase().startsWith('y'));
        }
      } finally {
        rl.close();
      }
    }

    const result = await confirmContentDraft({ repo, date, externalId, platform, answers, note: opts.note });
    console.log(`\n✅ 门③ 通过: ${result.date} ${result.externalId} ${PLATFORM_LABEL[result.platform]} 已确认（决策 append-only 留痕，run ${result.runId.slice(0, 8)}…）`);
    console.log('   发布仍为人工动作：复制内容 → 平台发布并勾选「AI 生成」标注');
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('discard <externalId> <platform>')
  .description('弃用草稿（记入决策流水；如需重做用 content-gen --force）')
  .option('--date <date>', '日期 YYYY-MM-DD，默认今天')
  .option('--note <note>', '备注（写入决策流水）')
  .option('--db <mode>', 'pg | memory')
  .action(async (externalId: string, platformRaw: string, opts: { date?: string; note?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    const platform = parsePlatform(platformRaw);
    const result = await discardContentDraft({ repo, date: opts.date, externalId, platform, note: opts.note });
    console.log(`🗑 已弃用: ${result.date} ${result.externalId} ${PLATFORM_LABEL[result.platform]}（决策流水已留痕）`);
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('publish-sync')
  .description('发布队列同步（B2）：门③ 已确认内容 → 待发布记录（幂等，可随时重跑补漏）')
  .option('--date <date>', '批次日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { date?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    const result = await syncPublishQueue({ repo, date: opts.date });
    console.log(`publish-sync 完成: ${result.date} 新入队 ${result.created}，已有跳过 ${result.skipped}`);
    if (result.created > 0) {
      const items = await listPublishQueue({ repo, date: result.date });
      printPublishQueue(items);
    } else if (result.skipped === 0) {
      console.log('没有已确认内容（先 gwd content-gen + gwd confirm）');
    }
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('publish-list')
  .description('查看发布队列 + 发布台账（建议时段 / 超 24h 警示）')
  .option('--date <date>', '批次日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { date?: string; db?: string }) => {
    const date = opts.date ?? todayShanghai();
    const repo = createRepo(opts.db);
    const items = await listPublishQueue({ repo, date });
    if (items.length === 0) {
      console.log(`${date} 没有发布记录（先 gwd confirm + gwd publish-sync）`);
    } else {
      printPublishQueue(items);
    }
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('published <externalId> <platform>')
  .description('人工发布后回填台账（门④）：链接 / 时间 / AI 标注，一条只回填一次')
  .requiredOption('--url <url>', '已发布笔记/视频链接')
  .option('--at <iso>', '实际发布时间（ISO 格式，默认现在）')
  .option('--ai-labeled', '已在平台勾选「AI 生成」标注（默认未标注，如实回填）')
  .option('--date <date>', '批次日期 YYYY-MM-DD，默认今天')
  .option('--db <mode>', 'pg | memory')
  .action(async (externalId: string, platformRaw: string, opts: { url: string; at?: string; aiLabeled?: boolean; date?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    const platform = parsePlatform(platformRaw);
    const result = await recordPublish({
      repo,
      date: opts.date,
      externalId,
      platform,
      url: opts.url,
      publishedAt: opts.at,
      aiLabeled: opts.aiLabeled ?? false,
    });
    console.log(`✅ 台账已回填: ${result.date} ${result.externalId} ${PLATFORM_LABEL[result.platform]}`);
    console.log(`   链接 ${result.record.url}`);
    console.log(`   时间 ${isoToShanghaiDisplay(result.record.publishedAt!)}  AI 标注: ${result.record.aiLabeled ? '已勾选' : '未勾选 ⚠（平台要求 AI 内容须标注，未勾选请补）'}`);
    console.log('   （内容↔品↔平台↔时间已绑定，V3 归因的事实表就位）');
    if (repo instanceof PgRepo) await repo.close();
  });

program
  .command('sim-import')
  .description('导入 KuaiRec 模拟表现数据（B3 第一批：账号-内容-日粒度台账，幂等可重跑）')
  .option('--dir <dir>', '数据目录（默认 data/）')
  .option('--limit <n>', '最多读取主表行数（小样本试跑用，默认全量）', (v: string) => Number(v))
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { dir?: string; limit?: number; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const result = await runSimImport({ repo, dir: opts.dir, limit: opts.limit });
      console.log(`\nsim-import 完成（模拟数据 · source=kuairec，永不与真实数据混读）`);
      console.log(`  读取 ${result.total} 行：入库 ${result.inserted}，跳过已存在 ${result.skipped}，无效 ${result.invalid}`);
      console.log(`  覆盖 ${result.authorCount} 个账号 · ${result.videoCount} 条内容 · ${result.dateFrom} ~ ${result.dateTo}`);
      if (result.inserted > 0) console.log(`  看板: gwd sim-dashboard`);
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('sim-dashboard')
  .description('模拟数据账号看板（B3 第一批：日趋势 / Top 内容 / 环比异常日，零 LLM）')
  .option('--author <id>', '账号（作者 id），缺省取总曝光第一的头部账号')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { author?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const { dashboard: d, topAuthors } = await runSimDashboard({ repo, authorId: opts.author });
      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      console.log(`\n📊 模拟账号看板 — 账号 ${d.authorId}（${d.dateFrom} ~ ${d.dateTo} · ${d.videoCount} 条内容）`);
      console.log(`⚠ ${d.disclaimer}`);
      console.log('—— 账号层总量 ——');
      console.log(`  曝光 ${d.totals.showCnt.toLocaleString()} · 播放 ${d.totals.playCnt.toLocaleString()} · 完播率 ${pct(d.totals.completeRate)} · 互动率 ${pct(d.totals.interactionRate)}`);
      console.log(`  点赞 ${d.totals.likeCnt.toLocaleString()} · 评论 ${d.totals.commentCnt.toLocaleString()} · 分享 ${d.totals.shareCnt.toLocaleString()} · 涨粉 ${d.totals.followCnt.toLocaleString()}`);
      if (d.daily.length > 0) {
        console.log('—— 日趋势（曝光 / 播放 / 完播率 / 互动率 / 涨粉）——');
        for (const p of d.daily) {
          console.log(`  ${p.date}  ${String(p.showCnt).padStart(9)}  ${String(p.playCnt).padStart(9)}  ${pct(p.completeRate).padStart(6)}  ${pct(p.interactionRate).padStart(6)}  ${String(p.followCnt).padStart(6)}`);
        }
      }
      if (d.topContents.length > 0) {
        console.log('—— Top 内容（按总曝光）——');
        d.topContents.forEach((c, i) => {
          console.log(`  ${i + 1}. [${c.videoId}] ${c.caption ?? '（无文案）'}${c.category ? ` · ${c.category}` : ''}`);
          console.log(`     曝光 ${c.showCnt.toLocaleString()} · 播放 ${c.playCnt.toLocaleString()} · 完播率 ${pct(c.completeRate)} · 点赞 ${c.likeCnt.toLocaleString()}`);
        });
      }
      if (d.anomalies.length > 0) {
        console.log('—— 曝光环比异常日（前日曝光 ≥ 1 万且变动 ≥ ±50%，复盘切入点）——');
        for (const a of d.anomalies) {
          console.log(`  ${a.date}  ${a.direction === 'up' ? '↑ 涨' : '↓ 跌'} ${pct(Math.abs(a.changePct))}（${a.previousShow.toLocaleString()} → ${a.showCnt.toLocaleString()}）`);
        }
      } else {
        console.log('—— 曝光环比异常日：无（各日变动均 < ±50%）——');
      }
      if (topAuthors.length > 1) {
        console.log(`—— 头部账号（换看: gwd sim-dashboard --author <id>）——`);
        console.log(`  ${topAuthors.map((a) => `${a.authorId}（曝光 ${a.totalShow.toLocaleString()} / ${a.videoCount} 条）`).join('  ·  ')}`);
      }
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('sim-play-import')
  .description('导入 KuaiRec 播放级事件（B3 第二批：small_matrix 约 467 万行，供单内容下钻，幂等可重跑）')
  .option('--dir <dir>', '数据目录（默认 data/）')
  .option('--limit <n>', '最多读取行数（小样本试跑用，默认全量）', (v: string) => Number(v))
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { dir?: string; limit?: number; db?: string }) => {
    const repo = createRepo(opts.db);
    const started = Date.now();
    try {
      const result = await runSimPlayImport({ repo, dir: opts.dir, limit: opts.limit });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\nsim-play-import 完成（模拟数据 · source=kuairec，永不与真实数据混读 · 耗时 ${secs}s）`);
      console.log(`  读取 ${result.total.toLocaleString()} 行：入库 ${result.inserted.toLocaleString()}，跳过已存在 ${result.skipped.toLocaleString()}，无效 ${result.invalid.toLocaleString()}`);
      console.log(`  覆盖 ${result.videoCount.toLocaleString()} 条内容 · ${result.userCount.toLocaleString()} 个用户 · ${result.dateFrom ?? '-'} ~ ${result.dateTo ?? '-'}`);
      if (result.inserted > 0) console.log(`  下钻: gwd sim-content <video_id>`);
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('sim-content <video_id>')
  .description('模拟数据单内容下钻（B3 第二批：watch_ratio 分位数 / 完播占比 / 观看时长分布，零 LLM）')
  .option('--db <mode>', 'pg | memory')
  .action(async (videoId: string, opts: { db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const d = await runSimContent({ repo, videoId });
      const pct = (v: number | null): string => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
      const q = (v: number | null): string => (v == null ? '-' : v.toFixed(3));
      console.log(`\n🔍 单内容下钻 — [${d.videoId}]${d.caption ? ` ${d.caption}` : ''}`);
      console.log(`⚠ ${d.disclaimer}`);
      if (d.authorId != null) console.log(`  账号 ${d.authorId}${d.category ? ` · 类目 ${d.category}` : ''}${d.uploadDt ? ` · 发布 ${d.uploadDt}` : ''}`);
      console.log(`—— 日粒度台账（sim_content_stats · ${d.stats.days} 天）——`);
      console.log(`  曝光 ${d.stats.showCnt.toLocaleString()} · 播放 ${d.stats.playCnt.toLocaleString()} · 完播率 ${pct(d.stats.completeRate)} · 点赞 ${d.stats.likeCnt.toLocaleString()} · 涨粉 ${d.stats.followCnt.toLocaleString()}`);
      console.log(`—— 播放级样本（sim_play_events · 样本量 ${d.playLevel.sampleCount.toLocaleString()}，${d.playLevel.userCount.toLocaleString()} 个用户${d.playLevel.dateFrom ? ` · ${d.playLevel.dateFrom} ~ ${d.playLevel.dateTo}` : ''}）——`);
      console.log(`  watch_ratio 分位数  p25 ${q(d.playLevel.watchRatio.p25)} · p50 ${q(d.playLevel.watchRatio.p50)} · p75 ${q(d.playLevel.watchRatio.p75)} · p90 ${q(d.playLevel.watchRatio.p90)} · 均值 ${q(d.playLevel.watchRatio.mean)}`);
      console.log(`  完播占比（watch_ratio ≥ 1）${pct(d.playLevel.watchRatio.completeRatio)}（参与样本 ${d.playLevel.watchRatio.ratioSampleCount.toLocaleString()}）`);
      console.log(`  观看时长分位数  p25 ${d.playLevel.playDuration.p25 ?? '-'} · p50 ${d.playLevel.playDuration.p50 ?? '-'} · p75 ${d.playLevel.playDuration.p75 ?? '-'} · p90 ${d.playLevel.playDuration.p90 ?? '-'} · 均值 ${d.playLevel.playDuration.mean ?? '-'}`);
      console.log(`  （注意：播放级样本是数据集子集，样本量 ≠ 台账播放量，两者分开解读）`);
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('sim-weekly')
  .description('模拟数据周复盘报告（B3 第三批：本周 vs 上周环比 / Top·Bottom 内容 / 规则建议，零 LLM）')
  .option('--author <id>', '账号（作者 id），缺省取总曝光第一的头部账号')
  .option('--date <date>', '周结束日 YYYY-MM-DD（含当天，往前 7 天为本周），缺省取最后有数据的一天')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { author?: string; date?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const r = await runSimWeekly({ repo, authorId: opts.author, weekEnd: opts.date });
      const pct = (v: number | null): string => (v == null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
      const pp = (v: number | null): string => (v == null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`);
      const ratio = (v: number): string => `${(v * 100).toFixed(1)}%`;
      console.log(`\n📋 周复盘 — 账号 ${r.authorId} · ${r.currentWeek.dateFrom} ~ ${r.currentWeek.dateTo}`);
      console.log(`⚠ ${r.disclaimer}`);
      console.log('—— 本周 vs 上周 ——');
      const c = r.comparison;
      const prev = c.previous;
      const line = (label: string, cur: number, prevV: number | null, chg: string): void => {
        const prevStr = prevV == null ? '无数据' : prevV.toLocaleString();
        console.log(`  ${label}  本周 ${cur.toLocaleString()} · 上周 ${prevStr} · ${chg}`);
      };
      line('曝光  ', c.current.showCnt, prev?.showCnt ?? null, pct(c.changes.showCnt));
      line('播放  ', c.current.playCnt, prev?.playCnt ?? null, pct(c.changes.playCnt));
      console.log(`  完播率  本周 ${ratio(c.current.completeRate)} · 上周 ${prev ? ratio(prev.completeRate) : '无数据'} · ${pp(c.changes.completeRatePp)}`);
      console.log(`  互动率  本周 ${ratio(c.current.interactionRate)} · 上周 ${prev ? ratio(prev.interactionRate) : '无数据'} · ${pp(c.changes.interactionRatePp)}`);
      line('涨粉  ', c.current.followCnt, prev?.followCnt ?? null, pct(c.changes.followCnt));
      console.log(`  本周内容数 ${c.current.videoCount}${prev ? `（上周 ${prev.videoCount}）` : ''}`);
      if (r.anomalies.length > 0) {
        console.log('—— 本周异常日（前日曝光 ≥ 1 万且变动 ≥ ±50%）——');
        for (const a of r.anomalies) {
          console.log(`  ${a.date}  ${a.direction === 'up' ? '↑ 涨' : '↓ 跌'} ${Math.abs(a.changePct * 100).toFixed(0)}%（${a.previousShow.toLocaleString()} → ${a.showCnt.toLocaleString()}）`);
        }
      }
      if (r.topContents.length > 0) {
        console.log('—— Top 内容（本周按曝光）——');
        r.topContents.forEach((t, i) => {
          console.log(`  ${i + 1}. [${t.videoId}] ${t.caption ?? '（无文案）'}${t.category ? ` · ${t.category}` : ''}`);
          console.log(`     曝光 ${t.showCnt.toLocaleString()} · 完播率 ${ratio(t.completeRate)} · 点赞 ${t.likeCnt.toLocaleString()} · 涨粉 ${t.followCnt.toLocaleString()}`);
        });
      }
      if (r.bottomContents.length > 0) {
        console.log(`—— Bottom 内容（本周曝光 ≥ 1000 且完播率垫底，复盘病灶）——`);
        for (const b of r.bottomContents) {
          console.log(`  [${b.videoId}] ${b.caption ?? '（无文案）'}：曝光 ${b.showCnt.toLocaleString()} · 完播率 ${ratio(b.completeRate)}`);
        }
      }
      console.log('—— 下周建议（规则触发，非 LLM，人判采纳）——');
      r.suggestions.forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.text}`);
        console.log(`     触发规则：${s.rule}（${s.trigger}）`);
      });
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('sim-weekly-ai')
  .description('周报 AI 叙事 + 规则调整建议（模块⑤：零 LLM 骨架之上加 LLM 层，建议→提案草案→人批准）')
  .option('--author <id>', '账号（作者 id），缺省取总曝光第一的头部账号')
  .option('--date <date>', '周结束日 YYYY-MM-DD（含当天，往前 7 天为本周），缺省取最后有数据的一天')
  .option('--propose-dir <dir>', '把规则建议写成 rule propose 兼容的提案 JSON 文件（人审后 gwd rule propose <file>）')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { author?: string; date?: string; proposeDir?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const agent = createWeeklyAgentFromEnv();
      if (!agent) console.log('ℹ 未配置 OPENAI_API_KEY —— 降级为零 LLM 骨架（gwd sim-weekly 同款输出）');
      const r = await runSimWeeklyAI({ repo, authorId: opts.author, weekEnd: opts.date, agent });
      const pct = (v: number | null): string => (v == null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
      const pp = (v: number | null): string => (v == null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`);
      const ratio = (v: number): string => `${(v * 100).toFixed(1)}%`;
      console.log(`\n📋 周报复盘（AI 叙事）— 账号 ${r.report.authorId} · ${r.report.currentWeek.dateFrom} ~ ${r.report.currentWeek.dateTo}`);
      console.log(`⚠ ${r.report.disclaimer}`);
      // 零 LLM 骨架核心（完整版见 gwd sim-weekly）
      const c = r.report.comparison;
      console.log('—— 骨架数据（系统计算）——');
      console.log(`  曝光 ${c.current.showCnt.toLocaleString()}（环比 ${pct(c.changes.showCnt)}） · 播放 ${c.current.playCnt.toLocaleString()}（${pct(c.changes.playCnt)}）`);
      console.log(`  完播率 ${ratio(c.current.completeRate)}（${pp(c.changes.completeRatePp)}） · 互动率 ${ratio(c.current.interactionRate)}（${pp(c.changes.interactionRatePp)}）`);
      console.log(`  涨粉 ${c.current.followCnt.toLocaleString()}（${pct(c.changes.followCnt)}） · 本周内容数 ${c.current.videoCount}`);
      if (r.report.anomalies.length > 0) {
        console.log(`  异常日 ${r.report.anomalies.length} 个: ${r.report.anomalies.map((a) => `${a.date}${a.direction === 'up' ? '↑' : '↓'}${Math.abs(a.changePct * 100).toFixed(0)}%`).join('、')}`);
      }
      console.log('—— AI 叙事 ——');
      if (r.narrative) {
        console.log(`  ${r.narrative.summary}`);
      } else {
        console.log(`  ⚠ 无 AI 叙事${r.budgetExceeded ? '（LLM 日预算已用尽）' : '（LLM 未配置或校验丢弃）'}——以上骨架数据即完整结论（gwd sim-weekly 看规则触发建议）`);
      }
      console.log('—— 规则调整建议（AI 提案草案，人批准前不生效）——');
      if (r.proposals.length === 0) {
        console.log('  无（数据不支撑或建议被校验丢弃——宁缺勿滥）');
      }
      r.proposals.forEach((p, i) => {
        console.log(`  ${i + 1}. 依据: ${p.basis}`);
        console.log(`     预期效果: ${p.expectedEffect}`);
        const changes = Object.entries(diffRule(r.activeRule as unknown as Record<string, unknown>, p.config as unknown as Record<string, unknown>)).map(([k, [from, to]]) => `${k}: ${from} → ${to}`);
        console.log(`     参数变更: ${changes.join('；')}`);
      });
      if (r.degraded) {
        console.log(`⚠ 部分产出被降级丢弃${r.budgetExceeded ? '（LLM 日预算已用尽）' : '（LLM 失败或校验丢弃）'}`);
      }
      if (opts.proposeDir && r.proposals.length > 0) {
        mkdirSync(opts.proposeDir, { recursive: true });
        r.proposals.forEach((p, i) => {
          const file = join(opts.proposeDir!, `proposal-${i + 1}.json`);
          writeFileSync(file, JSON.stringify({ basis: p.basis, expectedEffect: p.expectedEffect, config: p.config }, null, 2), 'utf8');
          console.log(`已写提案草案: ${file}`);
        });
        console.log('人审后生效链: gwd rule propose <file> → gwd rule proposals → gwd rule approve <id>（批准时刻重校验 + 可 rollback）');
      } else if (r.proposals.length > 0) {
        console.log('（--propose-dir <dir> 可把建议导出为提案文件）');
      }
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

/** 提案 config 与 active 规则的差异（展示用：白名单路径上的数值变化） */
function diffRule(active: Record<string, unknown>, proposal: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  const paths = [
    'gates.minCommissionRate', 'gates.minReviewRate', 'gates.maxReturnRate', 'gates.minMerchantScore',
    'grading.strongMin', 'grading.testMin', 'topN',
  ];
  const get = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((cur, p) => (cur == null ? undefined : (cur as Record<string, unknown>)[p]), obj);
  for (const p of paths) {
    const from = get(active, p);
    const to = get(proposal, p);
    if (from !== to && to !== undefined) out[p] = [from, to];
  }
  return out;
}

program
  .command('real-import <csv>')
  .description('导入本人账号真实表现数据（P0：抖音创作者后台导出 CSV → 账号-内容-日台账，幂等可重跑）')
  .option('--limit <n>', '最多读取行数（试跑用，默认全量）', (v: string) => Number(v))
  .option('--db <mode>', 'pg | memory')
  .action(async (csv: string, opts: { limit?: number; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const result = await runRealImport({ repo, file: csv, limit: opts.limit });
      console.log(`\nreal-import 完成（真实数据 · source=manual，与模拟数据 kuairec 按 source 隔离，永不混读）`);
      console.log(`  读取 ${result.total} 行：入库 ${result.inserted}，跳过已存在 ${result.skipped}，无效 ${result.invalid}`);
      console.log(`  覆盖 ${result.authorCount} 个账号 · ${result.videoCount} 条内容 · ${result.dateFrom} ~ ${result.dateTo}`);
      if (result.unknown.length > 0) console.log(`  ⚠ 未识别的表头（已忽略）: ${result.unknown.join('、')}`);
      if (result.inserted > 0) console.log(`  看板: gwd real-dashboard`);
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
  });

program
  .command('real-dashboard')
  .description('真实数据账号看板（P0：日趋势 / Top 内容 / 环比异常日，零 LLM，口径与模拟看板一致）')
  .option('--author <id>', '账号 ID（模板「账号ID」列），缺省取总曝光第一的账号')
  .option('--db <mode>', 'pg | memory')
  .action(async (opts: { author?: string; db?: string }) => {
    const repo = createRepo(opts.db);
    try {
      const { dashboard: d, topAuthors } = await runRealDashboard({ repo, authorId: opts.author });
      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      console.log(`\n📊 真实账号看板 — 账号 ${d.authorId}（${d.dateFrom} ~ ${d.dateTo} · ${d.videoCount} 条内容）`);
      console.log(`ℹ ${d.disclaimer}`);
      console.log('—— 账号层总量 ——');
      console.log(`  曝光 ${d.totals.showCnt.toLocaleString()} · 播放 ${d.totals.playCnt.toLocaleString()} · 完播率 ${pct(d.totals.completeRate)} · 互动率 ${pct(d.totals.interactionRate)}`);
      console.log(`  点赞 ${d.totals.likeCnt.toLocaleString()} · 评论 ${d.totals.commentCnt.toLocaleString()} · 分享 ${d.totals.shareCnt.toLocaleString()} · 涨粉 ${d.totals.followCnt.toLocaleString()}`);
      if (d.daily.length > 0) {
        console.log('—— 日趋势（曝光 / 播放 / 完播率 / 互动率 / 涨粉）——');
        for (const p of d.daily) {
          console.log(`  ${p.date}  ${String(p.showCnt).padStart(9)}  ${String(p.playCnt).padStart(9)}  ${pct(p.completeRate).padStart(6)}  ${pct(p.interactionRate).padStart(6)}  ${String(p.followCnt).padStart(6)}`);
        }
      }
      if (d.topContents.length > 0) {
        console.log('—— Top 内容（按总曝光）——');
        d.topContents.forEach((c, i) => {
          console.log(`  ${i + 1}. [${c.videoId}] ${c.caption ?? '（无文案）'}${c.category ? ` · ${c.category}` : ''}`);
          console.log(`     曝光 ${c.showCnt.toLocaleString()} · 播放 ${c.playCnt.toLocaleString()} · 完播率 ${pct(c.completeRate)} · 点赞 ${c.likeCnt.toLocaleString()}`);
        });
      }
      if (d.anomalies.length > 0) {
        console.log('—— 曝光环比异常日（前日曝光 ≥ 1 万且变动 ≥ ±50%，复盘切入点）——');
        for (const a of d.anomalies) {
          console.log(`  ${a.date}  ${a.direction === 'up' ? '↑ 涨' : '↓ 跌'} ${pct(Math.abs(a.changePct))}（${a.previousShow.toLocaleString()} → ${a.showCnt.toLocaleString()}）`);
        }
      } else {
        console.log('—— 曝光环比异常日：无（各日变动均 < ±50%）——');
      }
      if (topAuthors.length > 1) {
        console.log(`—— 账号一览（换看: gwd real-dashboard --author <id>）——`);
        console.log(`  ${topAuthors.map((a) => `${a.authorId}（曝光 ${a.totalShow.toLocaleString()} / ${a.videoCount} 条）`).join('  ·  ')}`);
      }
    } finally {
      if (repo instanceof PgRepo) await repo.close();
    }
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
    // 演示「人工漏填三维 → 待评」：补一条门槛过但三维缺失的快照
    await repo.upsertSnapshots(
      [
        {
          externalId: 'P1004',
          title: '厨房硅胶沥水垫',
          category: '厨房小工具',
          price: 29.9,
          commissionRate: 22,
          sales30d: 1800,
          momTrend: 'up',
          reviewRate: 95,
          returnRate: 3,
          merchantScore: 88,
          fulfillment: '现货',
          contentFriendliness: null,
          competition: null,
          repurchase: null,
          imageUrl: null,
        },
      ],
      date,
    );
    console.log(`    有效 ${csv.rows.length + 1} 行（含 1 个演示待评品 P1004），跳过 ${csv.errors.length} 行`);
    console.log('[3] daily-scan（脚本化 Agent 生成理由）');
    const result = await runDailyScan({ repo, date, agent: createScriptedReasonAgent() });
    console.log(`    打分 ${result.scoredCount}，入榜 ${result.topCount}，门槛淘汰 ${result.gateFailedCount}，理由 ${result.reasonSource}\n`);
    const list = (await repo.getDailyList(date))!;
    printList(list);
    // 待评品打档建议（V2 可选增强）：AI 建议档位 + 依据，人可改，不落库
    const grade = await runGradeSuggest({ repo, date, agent: createScriptedGradeAgent() });
    if (grade.pendingGrading.length > 0) {
      const p = grade.pendingGrading[0]!;
      const s = grade.suggestions.find((x) => x.externalId === p.externalId);
      console.log(`\n[3+] 打档建议演示：${p.externalId} 门槛过但三维漏填 → AI 建议（人可改，不落库）`);
      if (s) {
        console.log(`    建议: 内容友好 ${s.contentFriendliness} · 竞争缓和 ${s.competition} · 复购扩展 ${s.repurchase}`);
        console.log(`    依据: ${s.rationale.slice(0, 70)}${s.rationale.length > 70 ? '…' : ''}`);
      }
      console.log('    人工确认后填进 CSV → 重新导入 + daily-scan（打档唯一事实源是 CSV，系统不自动改分）');
    }
    const first = list.items.find((i) => i.gatePassed && i.complete && !i.selected);
    if (first) {
      console.log(`\n[4] 勾选门演示：勾选 ${first.externalId}`);
      const sel = await selectProducts({ repo, date, externalIds: [first.externalId], note: 'demo 勾选' });
      console.log(`    已落决策流水: ${sel.selected.join(', ')}（append-only，审计可回溯）`);
      console.log(`\n[4+] 深度调研演示（V2）：人工抄录评论区 → LLM 摘要（人终判）`);
      const research = await runResearch({
        repo,
        externalId: first.externalId,
        sourceText: [
          '买家A：尺寸刚好，厨房台面清爽多了，安装也简单，推荐！',
          '买家B：用了两周有点松动，客服补发了配件，还行吧',
          '买家C：这个能放微波炉旁边吗？怕高温变形',
          '买家D：颜值好看，放在台面上很满意',
          '商家页宣称：304不锈钢，承重10kg， durable 耐用',
        ].join('\n'),
        agent: createScriptedResearchAgent(),
      });
      console.log(
        `    舆情 ${research.summary.sentiment} · 好评点 ${research.summary.highlights.length} · 风险 ${research.summary.risks.length} · 素材点 ${research.summary.materialPoints.length}`,
      );
      console.log('    内容工坊生成该品时自动注入参考（买家关注点 = 素材，风险信号禁做冲突宣称）');
      console.log(`\n[5] content-gen 演示：为勾选品生成双版草稿（脚本化 Agent + 双层自检 + 调研注入）`);
      const content = await runContentGen({
        repo,
        date,
        agent: createScriptedContentAgent(),
        reviewer: createScriptedContentReviewer(),
      });
      console.log(
        `    勾选品 ${content.productCount}，生成 ${content.generated} 条草稿，需人工 ${content.needsManual}` +
          (content.revisions > 0 ? `，修订 ${content.revisions} 轮` : '') +
          (content.reviewed > 0 ? `，L2 审查 ${content.reviewed}` : ''),
      );
      for (const d of content.drafts) {
        const preview =
          d.content === null
            ? (d.note ?? '')
            : d.platform === 'xiaohongshu'
              ? `标题「${(d.content as XiaohongshuNote).title}」，正文 ${(d.content as XiaohongshuNote).body.length} 字`
              : `钩子「${(d.content as DouyinScript).hook}」`;
        console.log(`    [${PLATFORM_LABEL[d.platform]}] ${DRAFT_STATUS_LABEL[d.status]} ${preview}`);
      }

      console.log(`\n[6] 确认门（门③）演示：5 项清单人工确认（演示全过；真实使用 gwd confirm 逐项交互）`);
      const xhs = content.drafts.find((d) => d.platform === 'xiaohongshu')!;
      GATE3_CHECKLIST.forEach((item, i) => console.log(`    ${i + 1}. ${item} → ✅`));
      const gate = await confirmContentDraft({
        repo,
        date,
        externalId: xhs.externalId,
        platform: 'xiaohongshu',
        answers: GATE3_CHECKLIST.map(() => true),
        note: 'demo 确认',
      });
      const decisions = await repo.getContentDecisions(date);
      console.log(
        `    ${gate.externalId} ${PLATFORM_LABEL[gate.platform]} 已确认；决策流水 ${decisions.length} 条（append-only，5 项勾选留痕，run ${gate.runId.slice(0, 8)}…）`,
      );
      console.log('    发布仍为人工动作：复制内容 → 平台发布并勾选「AI 生成」标注');

      console.log(`\n[7] 发布台账（B2）演示：同步队列 → 提醒时段 → 人工发布后回填`);
      const sync = await syncPublishQueue({ repo, date });
      console.log(`    publish-sync: 新入队 ${sync.created}，已有跳过 ${sync.skipped}（幂等，可随时重跑补漏）`);
      const queue = await listPublishQueue({ repo, date });
      printPublishQueue(queue);
      const rec = await recordPublish({
        repo,
        date,
        externalId: xhs.externalId,
        platform: 'xiaohongshu',
        url: 'https://www.xiaohongshu.com/explore/demo0000000000000000',
        aiLabeled: true,
      });
      console.log(`    人工发布完成 → 台账回填: ${rec.externalId} ${PLATFORM_LABEL[rec.platform]}（内容↔品↔平台↔时间已绑定）`);
      const after = await listPublishQueue({ repo, date });
      printPublishQueue(after);
    }
    console.log(`\n[8] 结论回写闭环（模块⑤）演示：提案登记 → 人批准 → 版本化生效 → 可回滚`);
    const proposal = await repo.createRuleProposal({
      basis: 'demo 观察：佣金 15% 档品的曝光表现偏弱（模拟观察 · 参数未验证）',
      expectedEffect: '佣金门槛提到 18% 后内容转化更稳',
      config: { ...RULE_V1, version: RULE_V1.version + 1, gates: { ...RULE_V1.gates, minCommissionRate: 18 } },
    });
    console.log(`    提案登记: ${proposal.id} [pending]（只登记，不生效——系统永不自行改规则）`);
    const approved = await repo.decideRuleProposal(proposal.id, { action: 'approve', decidedBy: 'human' });
    console.log(`    人工批准 → 批准时刻重新校验 → 生效 v${approved.resultingVersion}（版本链 append-only）`);
    const rb = await repo.rollbackRule();
    console.log(`    不满意 → gwd rule rollback: v${rb.from} → v${rb.to}（demo 结束恢复原规则）`);

    console.log('\n=== demo 结束。真实使用：docker compose up -d → gwd migrate → gwd rule init → 每日 import-candidates + daily-scan → 勾选后 content-gen → confirm → publish-sync → 人工发布 → published 回填 ===');
  });

program.parseAsync().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
