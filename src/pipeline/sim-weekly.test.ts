/**
 * 模拟数据周复盘报告（B3 第三批）测试：滚动 7 天窗口 / 环比口径（比率用 pp）/
 * Top·Bottom 内容门槛 / 规则建议触发 / 跨周环比保留 / 空窗口与 repo 集成。
 * 红线：source 强制 'kuairec'；上周无数据环比记 null（不编数据）。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import type { SimContentStatRow } from '../db/repo.js';
import { buildSimWeeklyReport, dateAdd, runSimWeekly } from './sim-weekly.js';

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

describe('dateAdd（UTC 日期算术）', () => {
  it('加减天数 + 跨月边界', () => {
    expect(dateAdd('2020-08-10', -6)).toBe('2020-08-04');
    expect(dateAdd('2020-08-10', -13)).toBe('2020-07-28');
    expect(dateAdd('2020-08-01', -1)).toBe('2020-07-31');
    expect(dateAdd('2020-12-31', 1)).toBe('2021-01-01');
    expect(dateAdd('2020-02-28', 1)).toBe('2020-02-29'); // 闰年
  });
});

describe('buildSimWeeklyReport（纯计算）', () => {
  it('窗口切分 + 环比口径：计数用 %、比率用 pp', () => {
    // 上周（07-28~08-03）：2 天；本周（08-04~08-10）：1 天，曝光翻倍
    const rows = [
      stat({ statDate: '2020-07-29', showCnt: 50000, playCnt: 25000, completePlayCnt: 10000, followCnt: 50 }),
      stat({ statDate: '2020-07-30', showCnt: 50000, playCnt: 25000, completePlayCnt: 10000, followCnt: 50 }),
      stat({ statDate: '2020-08-10', showCnt: 100000, playCnt: 50000, completePlayCnt: 30000, followCnt: 200 }),
    ];
    const r = buildSimWeeklyReport(rows, 'A1', '2020-08-10');
    expect(r.currentWeek).toEqual({ dateFrom: '2020-08-10', dateTo: '2020-08-10' });
    expect(r.previousWeek).toEqual({ dateFrom: '2020-07-29', dateTo: '2020-07-30' });
    expect(r.comparison.current.showCnt).toBe(100000);
    expect(r.comparison.previous!.showCnt).toBe(100000);
    expect(r.comparison.changes.showCnt).toBe(0);
    expect(r.comparison.changes.followCnt).toBe(1); // 100 → 200
    // 完播率：上周 20000/50000=0.4，本周 30000/50000=0.6 → +20pp
    expect(r.comparison.changes.completeRatePp).toBeCloseTo(0.2);
    expect(r.comparison.current.videoCount).toBe(1);
  });

  it('上周无数据：previous 为 null，环比全 null（不编数据）', () => {
    const r = buildSimWeeklyReport([stat({ statDate: '2020-08-10' })], 'A1', '2020-08-10');
    expect(r.previousWeek).toBeNull();
    expect(r.comparison.previous).toBeNull();
    expect(r.comparison.changes.showCnt).toBeNull();
    expect(r.comparison.changes.completeRatePp).toBeNull();
  });

  it('窗口外数据不泄漏进本周/上周', () => {
    const rows = [
      stat({ statDate: '2020-08-10', showCnt: 10000 }),
      stat({ statDate: '2020-08-11', showCnt: 999999 }), // 窗口外（weekEnd 之后）
      stat({ statDate: '2020-07-27', showCnt: 888888 }), // 上周窗口外
    ];
    const r = buildSimWeeklyReport(rows, 'A1', '2020-08-10');
    expect(r.comparison.current.showCnt).toBe(10000);
    expect(r.comparison.previous).toBeNull();
  });

  it('Top 按曝光降序；Bottom 需曝光 ≥ 门槛且完播率垫底', () => {
    const rows = [
      // 本周 08-04~08-10 三条内容
      stat({ videoId: 'big', statDate: '2020-08-05', showCnt: 50000, playCnt: 25000, completePlayCnt: 12500 }),
      stat({ videoId: 'bad', statDate: '2020-08-05', showCnt: 2000, playCnt: 1000, completePlayCnt: 100 }), // 完播率 10%，曝光过门槛
      stat({ videoId: 'tiny', statDate: '2020-08-05', showCnt: 100, playCnt: 50, completePlayCnt: 0 }), // 完播率 0% 但曝光 < 1000，不参评
    ];
    const r = buildSimWeeklyReport(rows, 'A1', '2020-08-10');
    expect(r.topContents[0]!.videoId).toBe('big');
    expect(r.topContents).toHaveLength(3);
    expect(r.bottomContents).toHaveLength(2); // tiny 被门槛挡掉，big（完播率 0.5）也过门槛但排在 bad 后
    expect(r.bottomContents[0]!.videoId).toBe('bad');
    expect(r.bottomContents[0]!.completeRate).toBeCloseTo(0.1);
  });

  it('规则建议：曝光大跌 + 完播率下滑触发；平稳时给默认建议', () => {
    // 上周好本周差：曝光 -50%，完播率 0.5 → 0.2
    const declining = [
      stat({ statDate: '2020-08-03', showCnt: 200000, playCnt: 100000, completePlayCnt: 50000 }),
      stat({ statDate: '2020-08-10', showCnt: 100000, playCnt: 50000, completePlayCnt: 10000 }),
    ];
    const r1 = buildSimWeeklyReport(declining, 'A1', '2020-08-10');
    const rules = r1.suggestions.map((s) => s.rule);
    expect(rules).toContain('曝光环比跌 ≥ 30%');
    expect(rules).toContain('完播率下滑 ≥ 5pp');

    const stable = [stat({ statDate: '2020-08-03', showCnt: 100000 }), stat({ statDate: '2020-08-10', showCnt: 100000 })];
    const r2 = buildSimWeeklyReport(stable, 'A1', '2020-08-10');
    expect(r2.suggestions).toHaveLength(1);
    expect(r2.suggestions[0]!.rule).toBe('无规则触发');
  });

  it('规则建议：多内容且涨粉集中触发；单内容账号不评价集中度', () => {
    // 本周 2 条内容，v1 贡献 90% 涨粉
    const concentrated = [
      stat({ videoId: 'v1', statDate: '2020-08-05', showCnt: 50000, followCnt: 90 }),
      stat({ videoId: 'v2', statDate: '2020-08-05', showCnt: 50000, followCnt: 10 }),
    ];
    const r = buildSimWeeklyReport(concentrated, 'A1', '2020-08-10');
    expect(r.suggestions.map((s) => s.rule)).toContain('涨粉集中单一内容 ≥ 50%');

    // 单内容账号：涨粉 100% 集中但只有 1 条内容，不触发
    const single = [stat({ statDate: '2020-08-05', followCnt: 100 })];
    const r2 = buildSimWeeklyReport(single, 'A1', '2020-08-10');
    expect(r2.suggestions.map((s) => s.rule)).not.toContain('涨粉集中单一内容 ≥ 50%');
  });

  it('跨周环比保留：本周首日的异常日基于上周末数据判定', () => {
    // 08-03（上周末）20 万 → 08-04（本周首日）10 万，跌 50% 应被标记
    const rows = [
      stat({ statDate: '2020-08-03', showCnt: 200000 }),
      stat({ statDate: '2020-08-04', showCnt: 100000 }),
    ];
    const r = buildSimWeeklyReport(rows, 'A1', '2020-08-10');
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ date: '2020-08-04', direction: 'down' });
    expect(r.daily.map((p) => p.date)).toEqual(['2020-08-04']); // 日趋势只含本周
  });

  it('本周窗口无数据抛错（换 --date）', () => {
    expect(() => buildSimWeeklyReport([stat({ statDate: '2020-07-01' })], 'A1', '2020-08-10')).toThrow(/无模拟数据/);
  });
});

describe('runSimWeekly（repo 集成）', () => {
  it('空库抛错；缺省头部账号 + 缺省最后数据日', async () => {
    const repo = new MemoryRepo();
    await expect(runSimWeekly({ repo })).rejects.toThrow(/先执行 gwd sim-import/);
    await repo.upsertSimStats([
      stat({ statDate: '2020-08-01', showCnt: 100000 }),
      stat({ statDate: '2020-08-09', showCnt: 120000 }),
    ]);
    const r = await runSimWeekly({ repo });
    expect(r.authorId).toBe('A1');
    expect(r.currentWeek.dateTo).toBe('2020-08-09'); // 缺省取最后有数据的日期
    expect(r.currentWeek.dateFrom).toBe('2020-08-09'); // 实际数据范围：本周窗口 [08-04,08-10] 内仅 08-09 有数据
  });

  it('指定无数据账号抛错', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSimStats([stat()]);
    await expect(runSimWeekly({ repo, authorId: 'nobody' })).rejects.toThrow(/没有模拟数据/);
  });
});
