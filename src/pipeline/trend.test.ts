/**
 * 品类趋势背景板（模块① V3）测试：表头校验 / 指数清洗 / 幂等 / 汇总口径（日环比·区间·除零）/ 排序。
 * 断言契约不断言文案。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { parseTrendRecord, runTrendImport, validateTrendHeaders } from './trend-import.js';
import { runTrendList, trendDirection, TREND_DISCLAIMER } from './trend-list.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function csvFile(content: string): string {
  const dir = join(tmpdir(), `gwd-trend-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 't.csv');
  writeFileSync(f, content, 'utf8');
  return f;
}

const HEADER = '品类,日期,搜索指数\n';

describe('trend-import 契约', () => {
  it('表头校验：缺必填列整文件拒收', () => {
    expect(validateTrendHeaders(['品类', '日期'])).toContain('搜索指数');
    expect(validateTrendHeaders(['品类', '日期', '搜索指数'])).toBeNull();
  });

  it('parseTrendRecord：source 由代码写死 + 指数千分位容忍 + 负数/非数字作废', () => {
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026-11-01', 搜索指数: '12345' })!.searchIndex).toBe(12345);
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026-11-01', 搜索指数: '12,345' })!.searchIndex).toBe(12345);
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026-11-01', 搜索指数: '0' })!.searchIndex).toBe(0);
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026-11-01', 搜索指数: '1.5' })!.searchIndex).toBe(2); // 小数四舍五入（cleanCount 计数语义，与既有通道一致）
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026-11-01', 搜索指数: '-100' })).toBeNull();
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026-11-01', 搜索指数: 'abc' })).toBeNull();
    expect(parseTrendRecord({ 品类: '', 日期: '2026-11-01', 搜索指数: '100' })).toBeNull();
    expect(parseTrendRecord({ 品类: '保温杯', 日期: '2026/11/01', 搜索指数: '100' })).toBeNull();
  });

  it('导入统计：total/inserted/invalid/categoryCount/日期区间', async () => {
    const repo = new MemoryRepo();
    const f = csvFile(
      HEADER +
        '保温杯,2026-11-01,1000\n保温杯,2026-11-03,1200\n宠物饮水机,2026-11-02,500\n坏行,2026-11-01,-1\n',
    );
    const r = await runTrendImport({ repo, file: f });
    expect(r.total).toBe(4);
    expect(r.inserted).toBe(3);
    expect(r.invalid).toBe(1);
    expect(r.categoryCount).toBe(2);
    expect(r.dateFrom).toBe('2026-11-01');
    expect(r.dateTo).toBe('2026-11-03');
    rmSync(join(f, '..'), { recursive: true, force: true });
  });

  it('幂等：同文件重跑全部 skipped，数据不翻倍', async () => {
    const repo = new MemoryRepo();
    const f = csvFile(HEADER + '保温杯,2026-11-01,1000\n保温杯,2026-11-02,1100\n');
    await runTrendImport({ repo, file: f });
    const r2 = await runTrendImport({ repo, file: f });
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it('文件不存在 / 空文件：明确报错', async () => {
    await expect(runTrendImport({ repo: new MemoryRepo(), file: 'nope.csv' })).rejects.toThrow('找不到');
    const empty = csvFile('');
    await expect(runTrendImport({ repo: new MemoryRepo(), file: empty })).rejects.toThrow('空的');
  });
});

describe('trend-list 契约（MemoryRepo 汇总口径）', () => {
  it('日环比 / 区间涨跌幅 / 除零为 null / 排序（环比降序）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertCategoryTrends([
      { source: 'manual', category: '保温杯', statDate: '2026-11-01', searchIndex: 1000 },
      { source: 'manual', category: '保温杯', statDate: '2026-11-02', searchIndex: 1100 },
      { source: 'manual', category: '保温杯', statDate: '2026-11-03', searchIndex: 1320 }, // 日环比 +20%，区间 +32%
      { source: 'manual', category: '宠物饮水机', statDate: '2026-11-01', searchIndex: 500 },
      { source: 'manual', category: '宠物饮水机', statDate: '2026-11-02', searchIndex: 475 }, // 日环比 -5%，区间 -5%
    ]);
    const r = await runTrendList({ repo });
    expect(r.summaries).toHaveLength(2);
    expect(r.summaries[0]!.category).toBe('保温杯'); // +20% 排前
    expect(r.summaries[0]!.dayOverDayPct).toBeCloseTo(20, 5);
    expect(r.summaries[0]!.rangePct).toBeCloseTo(32, 5);
    expect(r.summaries[0]!.prevIndex).toBe(1100);
    expect(r.summaries[0]!.statDays).toBe(3);
    expect(r.summaries[1]!.dayOverDayPct).toBeCloseTo(-5, 5);
    expect(r.disclaimers).toContain(TREND_DISCLAIMER);
  });

  it('单日数据：prevIndex/dayOverDayPct 为 null（不猜）；除数为 0 → null', async () => {
    const repo = new MemoryRepo();
    await repo.upsertCategoryTrends([
      { source: 'manual', category: '单品类', statDate: '2026-11-01', searchIndex: 42 },
      { source: 'manual', category: '零基数', statDate: '2026-11-01', searchIndex: 0 },
      { source: 'manual', category: '零基数', statDate: '2026-11-02', searchIndex: 100 },
    ]);
    const r = await runTrendList({ repo });
    const single = r.summaries.find((s) => s.category === '单品类')!;
    expect(single.prevIndex).toBeNull();
    expect(single.dayOverDayPct).toBeNull();
    expect(single.rangePct).toBe(0); // 首日=末日 → 涨跌幅为 0（不是 null：除数非零有值可算）
    const zero = r.summaries.find((s) => s.category === '零基数')!;
    expect(zero.dayOverDayPct).toBeNull(); // prev=0 不除零
    expect(zero.rangePct).toBeNull(); // 首日=0 不除零
  });

  it('单品类下钻：日序列升序；未知品类报错', async () => {
    const repo = new MemoryRepo();
    await repo.upsertCategoryTrends([
      { source: 'manual', category: '保温杯', statDate: '2026-11-02', searchIndex: 1100 },
      { source: 'manual', category: '保温杯', statDate: '2026-11-01', searchIndex: 1000 },
    ]);
    const r = await runTrendList({ repo, category: '保温杯' });
    expect(r.series.map((s) => s.statDate)).toEqual(['2026-11-01', '2026-11-02']);
    await expect(runTrendList({ repo, category: '不存在' })).rejects.toThrow('还没有趋势数据');
  });

  it('trendDirection：±5% 阈值（参数未验证）', () => {
    expect(trendDirection(5)).toBe('↑');
    expect(trendDirection(4.9)).toBe('→');
    expect(trendDirection(-5)).toBe('↓');
    expect(trendDirection(-4.9)).toBe('→');
    expect(trendDirection(null)).toBe('→');
  });
});
