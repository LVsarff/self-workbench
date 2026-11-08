/**
 * PostgreSQL 真库集成冒烟（归因通道 db 层语义）。
 *
 * 为什么单测之外还要这个文件：MemoryRepo 验证的是「归因管线逻辑正确」，
 * 但 pg-repo 的 SQL（参数化 UPDATE 的 coalesce、join products 补 external_id/title、
 * video_id 列 + 部分索引、getSimStatsByVideo 参数化）只在真库上才真实执行——
 * 这些是 MemoryRepo 测不到的、pg 特有的正确性风险点。
 *
 * 门控：仅当 DATABASE_URL 指向可达的 PostgreSQL 才运行，否则 describe.skipIf 整体跳过
 * （不污染 CI / 日常 npm test）。
 *
 * 运行方式：
 *   docker compose up -d postgres        # postgres:16-alpine，默认 127.0.0.1:5432
 *   DATABASE_URL=postgres://gwd:gwd@127.0.0.1:5432/gwd \
 *     npx vitest run src/db/pg-repo.attribution.test.ts
 *
 * 造数：复用与 attribution.test.ts 完全相同的 pipeline 状态机（scan→select→gen→confirm→sync→record），
 * 让 pg-repo 用真实方法生成所有 uuid 外键关联，而非手写 INSERT 硬造。
 * 清理：每个用例用独立批次日期，跑完只删本测试造的 publish_records / sim_content_stats / content_drafts / product_snapshots。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PgRepo } from './pg-repo.js';
import { migrate } from './migrate.js';
import { buildAttribution } from '../pipeline/attribution.js';
import { recordPublish, syncPublishQueue } from '../pipeline/publish.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { selectProducts } from '../pipeline/select.js';
import { runContentGen } from '../pipeline/content-gen.js';
import { confirmContentDraft } from '../pipeline/content-confirm.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { RULE_V1 } from '../core/rule-config.js';

const URL = process.env.DATABASE_URL ?? '';
const SKIP = URL === '';

// 固定批次日期（独立于真实运营日期），beforeAll 前置清理保证重复运行自愈
const DATE = '2026-02-10';
const ALL_TRUE = [true, true, true, true, true];
const NOW_10 = new Date('2026-02-10T02:00:00Z');
const PUBLISHED_AT = '2026-02-10T13:00:00.000Z';

describe.skipIf(SKIP)('PostgreSQL 真库冒烟：归因通道 db 层语义', () => {
  let repo: PgRepo;

  // 前置清理 + 后置清理同一套逻辑：按外键依赖逆序删除（叶子表先删）
  async function cleanup(): Promise<void> {
    // 1) 引用 content_drafts 的叶子表
    await repo['pool'].query(`delete from content_decisions where batch_date = $1`, [DATE]);
    await repo['pool'].query(`delete from publish_records where batch_date = $1`, [DATE]);
    // 2) 内容草稿 + 表现数据
    await repo['pool'].query(`delete from content_drafts where batch_date = $1`, [DATE]);
    await repo['pool'].query(`delete from sim_content_stats where video_id in ('pgvx1','pgvx2')`);
    // 3) 引用 daily_runs 的其余叶子表
    await repo['pool'].query(`delete from score_records where run_id in (select id from daily_runs where batch_date = $1)`, [DATE]);
    await repo['pool'].query(`delete from reasons where run_id in (select id from daily_runs where batch_date = $1)`, [DATE]);
    await repo['pool'].query(`delete from decisions where batch_date = $1`, [DATE]);
    // 4) 商品快照（引用 products）+ run 本身
    await repo['pool'].query(`delete from product_snapshots where batch_date = $1`, [DATE]);
    await repo['pool'].query(`delete from daily_runs where batch_date = $1`, [DATE]);
  }

  beforeAll(async () => {
    await migrate(URL); // 幂等：确保 0012 video_id 列 + 部分索引存在
    repo = new PgRepo(URL);
    await cleanup(); // 前置清理：清掉上次可能残留的 run（防幂等拒绝）
  });

  afterAll(async () => {
    await cleanup();
    await repo.close();
  });

  it('迁移 0012 生效：publish_records.video_id 列 + published 部分索引存在', async () => {
    const col = await repo['pool'].query(
      `select 1 from information_schema.columns where table_name = 'publish_records' and column_name = 'video_id'`,
    );
    expect(col.rows).toHaveLength(1);
    const idx = await repo['pool'].query(
      `select 1 from pg_indexes where tablename = 'publish_records' and indexname = 'idx_publish_records_video'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('完整状态机在 pg 上落库 + 归因端到端跑通（join 出内容/品/平台三层）', async () => {
    // 同一套 pipeline（MemoryRepo 已验证逻辑），换成 PgRepo 走真实 SQL
    await repo.applyRuleVersion(RULE_V1, { reason: 'smoke', approvedBy: 't' });
    await repo.upsertSnapshots(
      [
        {
          externalId: 'PG-A', title: '商品PG-A', category: '家居收纳', price: 39.9, commissionRate: 25,
          sales30d: 3200, momTrend: 'up', reviewRate: 96, returnRate: 2, merchantScore: 85,
          fulfillment: '现货', contentFriendliness: 5, competition: 4, repurchase: 5, imageUrl: null,
        },
      ],
      DATE,
    );
    await runDailyScan({ repo, date: DATE, agent: null });
    await selectProducts({ repo, date: DATE, externalIds: ['PG-A'] });
    await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
    // 双平台各确认一条 → 品级有 2 条内容，样本充足（覆盖 sampleSufficient=true 分支）
    await confirmContentDraft({ repo, date: DATE, externalId: 'PG-A', platform: 'xiaohongshu', answers: ALL_TRUE });
    await confirmContentDraft({ repo, date: DATE, externalId: 'PG-A', platform: 'douyin', answers: ALL_TRUE });
    await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
    await recordPublish({ repo, date: DATE, externalId: 'PG-A', platform: 'xiaohongshu', url: 'https://xhs.link/pg', publishedAt: PUBLISHED_AT, videoId: 'pgvx1' });
    await recordPublish({ repo, date: DATE, externalId: 'PG-A', platform: 'douyin', url: 'https://v.douyin.com/pg', publishedAt: PUBLISHED_AT, videoId: 'pgvx2' });

    // 归因 db 层：listPublishedForAttribution join products 补 external_id/title
    const published = await repo.listPublishedForAttribution();
    const mine = published.find((r) => r.record.videoId === 'pgvx1');
    expect(mine).toBeDefined();
    expect(mine!.externalId).toBe('PG-A');
    expect(mine!.title).toBe('商品PG-A');

    // 造表现数据：manual 窗口内（xhs 一条 + douyin 一条）+ kuairec 撞号（不应参与）
    await repo.upsertSimStats([
      { source: 'manual', videoId: 'pgvx1', authorId: 'me', statDate: DATE, videoType: null, uploadDt: null, videoDuration: null, videoTagName: null, showCnt: 1000, playCnt: 100, completePlayCnt: 50, likeCnt: 10, commentCnt: 2, shareCnt: 1, followCnt: 5, collectCnt: 3, reportCnt: 0, caption: null, topicTag: null, category: null },
      { source: 'manual', videoId: 'pgvx2', authorId: 'me', statDate: DATE, videoType: null, uploadDt: null, videoDuration: null, videoTagName: null, showCnt: 500, playCnt: 50, completePlayCnt: 20, likeCnt: 5, commentCnt: 1, shareCnt: 0, followCnt: 2, collectCnt: 1, reportCnt: 0, caption: null, topicTag: null, category: null },
      { source: 'kuairec', videoId: 'pgvx1', authorId: 'attacker', statDate: DATE, videoType: null, uploadDt: null, videoDuration: null, videoTagName: null, showCnt: 9_999_999, playCnt: 9_999_999, completePlayCnt: 0, likeCnt: 0, commentCnt: 0, shareCnt: 0, followCnt: 0, collectCnt: 0, reportCnt: 0, caption: null, topicTag: null, category: null },
    ]);

    // getSimStatsByVideo 参数化 + source 锁 manual
    const manualRows = await repo.getSimStatsByVideo('manual', 'pgvx1');
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0]!.playCnt).toBe(100); // kuairec 撞号行不进 manual

    // buildAttribution 端到端：窗口累计 + 率值口径 + 未归因清单
    const report = await buildAttribution({ repo, days: 7 });
    const content = report.contents.find((c) => c.videoId === 'pgvx1');
    expect(content).toBeDefined();
    expect(content!.totals.playCnt).toBe(100); // kuairec 的 999 万不进
    expect(content!.completeRate).toBeCloseTo(50 / 100);
    expect(content!.interactionRate).toBeCloseTo((10 + 2 + 1 + 3) / 100);
    const product = report.products.find((p) => p.externalId === 'PG-A');
    expect(product!.sampleSufficient).toBe(true); // 2 条内容（pgvx1 + pgvx2）
    expect(product!.totals.playCnt).toBe(150); // 100 + 50，kuairec 撞号不进
  });

  it('危险 video_id 载荷经 setPublishVideoId 参数化：注入串被当普通字符串，DROP 不执行', async () => {
    const published = await repo.listPublishedForAttribution();
    const target = published.find((r) => r.record.videoId === 'pgvx1')!;
    const payload = "1'; DROP TABLE publish_records; --";
    // setPublishVideoId 用 $2 参数化：注入串被原样存储（无害），而非执行
    await repo.setPublishVideoId(target.record.id, payload);
    const after = await repo.listPublishedForAttribution();
    const mine = after.find((r) => r.record.id === target.record.id)!;
    expect(mine.record.videoId).toBe(payload);
    const tbl = await repo['pool'].query(`select 1 from publish_records limit 1`);
    expect(tbl.rows.length).toBeGreaterThan(0); // DROP 未执行，表仍在
    await repo.setPublishVideoId(target.record.id, 'pgvx1'); // 还原
  });
});
