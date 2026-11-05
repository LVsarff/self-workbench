/**
 * 真实表现数据导入 + 看板（P0）测试：字段映射 / 空值边界 / 表头校验 /
 * 幂等落库 / source 隔离（红线：manual 与 kuairec 永不混读）/ 端到端（临时 CSV）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { parseItemDailyRecord } from './sim-import.js';
import { parseRealRecord, parseIsoDate, runRealImport, validateHeaders, unknownHeaders, REAL_SOURCE } from './real-import.js';
import { REAL_DISCLAIMER, runRealDashboard } from './real-dashboard.js';

const REAL_CSV = [
  '账号ID,视频ID,日期,发布日期,视频时长秒,视频标签,曝光数,播放数,完播数,点赞数,评论数,分享数,涨粉数,收藏数,标题,话题,类目',
  'my-account,73001,2026-11-01,2026-10-28,32,好物分享,"15,200","9,800","3,100",420,35,28,66,180,秋冬围巾开箱,#秋冬穿搭,服饰·女装·配饰',
  'my-account,73001,2026-11-02,2026-10-28,32,好物分享,"18,300","12,100","3,900",510,41,33,72,210,秋冬围巾开箱,#秋冬穿搭,服饰·女装·配饰',
  'my-account,73002,2026-11-01,,45,,"5,000","3,200","1,100",10,5,10,20,,,,',
].join('\n');

describe('parseIsoDate（YYYY-MM-DD 校验）', () => {
  it('合法日期原样返回', () => {
    expect(parseIsoDate('2026-11-01')).toBe('2026-11-01');
    expect(parseIsoDate(' 2026-01-31 ')).toBe('2026-01-31');
  });

  it('非法输入返回 null（不抛错）', () => {
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('2026/11/01')).toBeNull();
    expect(parseIsoDate('20261101')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
  });
});

describe('表头校验', () => {
  it('必填齐全 → null', () => {
    expect(validateHeaders(['账号ID', '视频ID', '日期', '曝光数'])).toBeNull();
  });

  it('缺必填 → 报缺失列名', () => {
    expect(validateHeaders(['账号ID', '日期'])).toMatch(/视频ID/);
    expect(validateHeaders([])).toMatch(/账号ID/);
  });

  it('未知表头提示（不阻断）', () => {
    expect(unknownHeaders(['账号ID', '视频ID', '日期', '自造列'])).toEqual(['自造列']);
    expect(unknownHeaders(['账号ID', '视频ID', '日期', '曝光数', '标题'])).toEqual([]);
  });
});

describe('parseRealRecord（字段映射 + 空值边界）', () => {
  function rec(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      账号ID: 'my-account',
      视频ID: '73001',
      日期: '2026-11-01',
      发布日期: '2026-10-28',
      视频时长秒: '32',
      视频标签: '好物分享',
      曝光数: '15,200',
      播放数: '9,800',
      完播数: '3,100',
      点赞数: '420',
      评论数: '35',
      分享数: '28',
      涨粉数: '66',
      收藏数: '180',
      标题: '秋冬围巾开箱',
      话题: '#秋冬穿搭',
      类目: '服饰·女装·配饰',
      ...overrides,
    };
  }

  it('完整映射：source=manual、千分位计数、文本 enrich', () => {
    const row = parseRealRecord(rec())!;
    expect(row.source).toBe(REAL_SOURCE); // 红线：source 强制 manual
    expect(row.showCnt).toBe(15200);
    expect(row.playCnt).toBe(9800);
    expect(row.caption).toBe('秋冬围巾开箱');
    expect(row.topicTag).toBe('#秋冬穿搭');
    expect(row.uploadDt).toBe('2026-10-28');
    expect(row.videoDuration).toBe(32);
  });

  it('可选列全缺 → null / 0（不编造）', () => {
    const row = parseRealRecord({ 账号ID: 'a', 视频ID: 'v', 日期: '2026-11-01' })!;
    expect(row.uploadDt).toBeNull();
    expect(row.caption).toBeNull();
    expect(row.category).toBeNull();
    expect(row.showCnt).toBe(0);
    expect(row.followCnt).toBe(0);
    expect(row.reportCnt).toBe(0); // 后台无举报数，恒 0
  });

  it('缺关键列（账号/视频/坏日期）→ null 计 invalid', () => {
    expect(parseRealRecord(rec({ 账号ID: '' }))).toBeNull();
    expect(parseRealRecord(rec({ 视频ID: '' }))).toBeNull();
    expect(parseRealRecord(rec({ 日期: '2026/11/01' }))).toBeNull();
  });

  it('非法计数（负数/非数字）→ 整行作废，不猜', () => {
    expect(parseRealRecord(rec({ 曝光数: '-100' }))).toBeNull();
    expect(parseRealRecord(rec({ 播放数: 'abc' }))).toBeNull();
  });

  it('发布日期格式错 → 按 null 处理（行不作废）', () => {
    const row = parseRealRecord(rec({ 发布日期: '10月28日' }))!;
    expect(row.uploadDt).toBeNull();
  });
});

describe('source 隔离（红线：manual 与 kuairec 永不混读）', () => {
  it('同账号同视频同日：两个 source 各存一份，互不覆盖', async () => {
    const repo = new MemoryRepo();
    const manual = parseRealRecord({ 账号ID: 'acc', 视频ID: 'v1', 日期: '2026-11-01', 曝光数: '100' })!;
    const kuairec = parseItemDailyRecord(
      { video_id: 'v1', date: '20261101', author_id: 'acc', show_cnt: '999' } as Record<string, string>,
      new Map(),
    )!;
    expect(kuairec).not.toBeNull();
    const r = await repo.upsertSimStats([manual, kuairec]);
    expect(r.inserted).toBe(2); // 幂等键含 source，互不冲突

    const manualRows = await repo.getSimStatsByAuthor('manual', 'acc');
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0]!.showCnt).toBe(100);

    const simRows = await repo.getSimStatsByAuthor('kuairec', 'acc');
    expect(simRows).toHaveLength(1);
    expect(simRows[0]!.showCnt).toBe(999);
  });

  it('账号一览按 source 各自统计，不串台', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSimStats([
      parseRealRecord({ 账号ID: 'real-acc', 视频ID: 'v1', 日期: '2026-11-01', 曝光数: '10' })!,
      parseItemDailyRecord({ video_id: 's1', date: '20260101', author_id: 'sim-acc', show_cnt: '999999' } as Record<string, string>, new Map())!,
    ]);
    expect((await repo.listSimAuthors('manual', 10)).map((a) => a.authorId)).toEqual(['real-acc']);
    expect((await repo.listSimAuthors('kuairec', 10)).map((a) => a.authorId)).toEqual(['sim-acc']);
  });

  it('真实看板只看 manual 数据 + 带真实声明；模拟数据再大也不混入', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSimStats([
      parseRealRecord({ 账号ID: 'real-acc', 视频ID: 'v1', 日期: '2026-11-01', 曝光数: '1000', 播放数: '500' })!,
      parseRealRecord({ 账号ID: 'real-acc', 视频ID: 'v1', 日期: '2026-11-02', 曝光数: '3000', 播放数: '1500' })!,
      parseItemDailyRecord({ video_id: 'v1', date: '20261101', author_id: 'real-acc', show_cnt: '99999999' } as Record<string, string>, new Map())!,
    ]);
    const { dashboard } = await runRealDashboard({ repo, authorId: 'real-acc' });
    expect(dashboard.totals.showCnt).toBe(4000); // 模拟的 9999 万不混入
    expect(dashboard.disclaimer).toBe(REAL_DISCLAIMER);
    expect(dashboard.daily).toHaveLength(2);
  });

  it('真实数据为空时给出引导（不回退到模拟数据）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSimStats([
      parseItemDailyRecord({ video_id: 's1', date: '20260101', author_id: 'sim-acc', show_cnt: '100' } as Record<string, string>, new Map())!,
    ]);
    await expect(runRealDashboard({ repo })).rejects.toThrow(/先执行 gwd real-import/);
    await expect(runRealDashboard({ repo, authorId: 'sim-acc' })).rejects.toThrow(/没有真实数据/);
  });
});

describe('runRealImport 端到端（临时文件）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeCsv(content = REAL_CSV): string {
    const d = mkdtempSync(join(tmpdir(), 'gwd-real-'));
    dirs.push(d);
    const f = join(d, 'real.csv');
    writeFileSync(f, content, 'utf8');
    return f;
  }

  it('导入 → 落库 → 重跑全跳过（幂等）', async () => {
    const repo = new MemoryRepo();
    const file = makeCsv();
    const first = await runRealImport({ repo, file });
    expect(first.total).toBe(3);
    expect(first.inserted).toBe(3);
    expect(first.invalid).toBe(0);
    expect(first.authorCount).toBe(1);
    expect(first.videoCount).toBe(2);
    expect(first.dateFrom).toBe('2026-11-01');
    expect(first.dateTo).toBe('2026-11-02');

    const rows = await repo.getSimStatsByAuthor('manual', 'my-account');
    expect(rows).toHaveLength(3);
    const v2 = rows.find((r) => r.videoId === '73002')!;
    expect(v2.showCnt).toBe(5000); // 「5,000」千分位已清洗
    expect(v2.caption).toBeNull(); // 缺失文本不编造

    const second = await runRealImport({ repo, file });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
    expect((await repo.getSimStatsByAuthor('manual', 'my-account')).length).toBe(3); // 无重复
  });

  it('无效行计 invalid 不阻断（缺账号 + 坏日期）', async () => {
    const csv = [
      '账号ID,视频ID,日期,曝光数',
      ',v1,2026-11-01,100',
      'a,v2,11月1日,100',
      'a,v3,2026-11-01,100',
    ].join('\n');
    const repo = new MemoryRepo();
    const result = await runRealImport({ repo, file: makeCsv(csv) });
    expect(result.total).toBe(3);
    expect(result.invalid).toBe(2);
    expect(result.inserted).toBe(1);
  });

  it('缺必填表头整文件拒收（错列早失败）', async () => {
    const csv = ['account,video,date,show', 'a,v1,2026-11-01,100'].join('\n');
    const repo = new MemoryRepo();
    await expect(runRealImport({ repo, file: makeCsv(csv) })).rejects.toThrow(/缺少必填表头/);
    expect((await repo.getSimStatsByAuthor('manual', 'a')).length).toBe(0); // 一行都没落
  });

  it('未知表头提示但继续导入', async () => {
    const csv = ['账号ID,视频ID,日期,曝光数,备注列', 'a,v1,2026-11-01,100,x'].join('\n');
    const repo = new MemoryRepo();
    const result = await runRealImport({ repo, file: makeCsv(csv) });
    expect(result.unknown).toEqual(['备注列']);
    expect(result.inserted).toBe(1);
  });

  it('limit 截断读取行数', async () => {
    const repo = new MemoryRepo();
    const result = await runRealImport({ repo, file: makeCsv(), limit: 1 });
    expect(result.total).toBe(1);
    expect(result.inserted).toBe(1);
  });

  it('缺文件 / 空文件抛错', async () => {
    const repo = new MemoryRepo();
    await expect(runRealImport({ repo, file: 'not-exist.csv' })).rejects.toThrow(/找不到 CSV 文件/);
    await expect(runRealImport({ repo, file: makeCsv('') })).rejects.toThrow(/CSV 是空的/);
  });
});
