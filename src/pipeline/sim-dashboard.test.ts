/**
 * 模拟数据账号看板（B3 第一批）测试：计算口径 / 除零边界 / 趋势与 Top /
 * 环比异常日阈值 / 空数据与缺省账号解析。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import type { SimContentStatRow } from '../db/repo.js';
import { ANOMALY_THRESHOLD, buildSimDashboard, runSimDashboard, SIM_DISCLAIMER } from './sim-dashboard.js';

function stat(overrides: Partial<SimContentStatRow> = {}): SimContentStatRow {
  return {
    source: 'kuairec',
    videoId: 'v1',
    authorId: 'A1',
    statDate: '2020-07-05',
    videoType: 'NORMAL',
    uploadDt: '2020-06-01',
    videoDuration: 10000,
    videoTagName: null,
    showCnt: 1000,
    playCnt: 500,
    completePlayCnt: 300,
    likeCnt: 50,
    commentCnt: 5,
    shareCnt: 5,
    followCnt: 10,
    collectCnt: 8,
    reportCnt: 0,
    caption: '测试文案',
    topicTag: null,
    category: '颜值·颜值随拍',
    ...overrides,
  };
}

describe('buildSimDashboard 计算口径', () => {
  it('总量：完播率/互动率/涨粉 + 声明标注', () => {
    const d = buildSimDashboard([stat()], 'A1');
    expect(d.disclaimer).toBe(SIM_DISCLAIMER);
    expect(d.authorId).toBe('A1');
    expect(d.videoCount).toBe(1);
    expect(d.totals.completeRate).toBeCloseTo(300 / 500);
    expect(d.totals.interactionRate).toBeCloseTo((50 + 5 + 5) / 500);
    expect(d.totals.followCnt).toBe(10);
    expect(d.dateFrom).toBe('2020-07-05');
    expect(d.dateTo).toBe('2020-07-05');
  });

  it('除零边界：播放为 0 时比率记 0 不 NaN', () => {
    const d = buildSimDashboard([stat({ showCnt: 0, playCnt: 0, completePlayCnt: 0, likeCnt: 0, commentCnt: 0, shareCnt: 0 })], 'A1');
    expect(d.totals.completeRate).toBe(0);
    expect(d.totals.interactionRate).toBe(0);
    expect(d.daily[0]!.completeRate).toBe(0);
  });

  it('日趋势：按日期升序聚合多视频', () => {
    const d = buildSimDashboard([
      stat({ statDate: '2020-07-06', showCnt: 100, playCnt: 60, completePlayCnt: 30 }),
      stat({ videoId: 'v2', statDate: '2020-07-05', showCnt: 900, playCnt: 400, completePlayCnt: 200 }),
      stat({ statDate: '2020-07-05', showCnt: 100, playCnt: 100, completePlayCnt: 100 }),
    ], 'A1');
    expect(d.daily.map((p) => p.date)).toEqual(['2020-07-05', '2020-07-06']);
    expect(d.daily[0]!.showCnt).toBe(1000);
    expect(d.daily[0]!.completeRate).toBeCloseTo(300 / 500);
    expect(d.daily[1]!.showCnt).toBe(100);
  });

  it('Top 内容：按总曝光降序 + 视频内跨日聚合', () => {
    const d = buildSimDashboard([
      stat({ videoId: 'big', statDate: '2020-07-05', showCnt: 5000 }),
      stat({ videoId: 'big', statDate: '2020-07-06', showCnt: 4000, playCnt: 0 }),
      stat({ videoId: 'small', statDate: '2020-07-05', showCnt: 100 }),
    ], 'A1');
    expect(d.topContents.length).toBe(2);
    expect(d.topContents[0]!.videoId).toBe('big');
    expect(d.topContents[0]!.showCnt).toBe(9000);
  });
});

describe('buildSimDashboard 环比异常日', () => {
  // 门槛 MIN_SHOW_BASELINE = 10000：异常日判定要求前日曝光 ≥ 1 万（小基数天是噪声）
  function days(shows: number[]): SimContentStatRow[] {
    return shows.map((s, i) => stat({ statDate: `2020-07-${String(i + 1).padStart(2, '0')}`, showCnt: s, playCnt: Math.round(s / 2) }));
  }

  it('涨幅超阈值标记 up，跌幅超阈值标记 down', () => {
    const d = buildSimDashboard(days([100000, 200000, 220000, 80000]), 'A1');
    expect(d.anomalies.length).toBe(2);
    expect(d.anomalies[0]).toMatchObject({ date: '2020-07-02', direction: 'up', changePct: 1 });
    expect(d.anomalies[1]).toMatchObject({ date: '2020-07-04', direction: 'down', previousShow: 220000, showCnt: 80000 });
    expect(Math.abs(d.anomalies[1]!.changePct)).toBeGreaterThanOrEqual(ANOMALY_THRESHOLD);
  });

  it('变动低于阈值不标记（10万→12万 不算异常）', () => {
    const d = buildSimDashboard(days([100000, 120000, 130000]), 'A1');
    expect(d.anomalies).toHaveLength(0);
  });

  it('首日无环比不参与；前日 0 曝光无基准跳过', () => {
    const d = buildSimDashboard(days([0, 50000, 60000]), 'A1');
    expect(d.anomalies).toHaveLength(0); // 07-01 无前日，07-02 前日为 0，07-03 涨 20% 不达阈值
  });

  it('降噪：前日曝光 < 1 万不参与判定（12→18 的 +50% 是小基数噪声）', () => {
    const d = buildSimDashboard(days([12, 18, 20000]), 'A1');
    expect(d.anomalies).toHaveLength(0); // 07-02 前日 12 < 门槛；07-03 前日 18 < 门槛
  });

  it('降噪不误伤：前日恰好 1 万参与判定', () => {
    const d = buildSimDashboard(days([10000, 20000]), 'A1');
    expect(d.anomalies).toHaveLength(1);
    expect(d.anomalies[0]).toMatchObject({ date: '2020-07-02', direction: 'up', previousShow: 10000, showCnt: 20000 });
  });

  it('单日数据无异常', () => {
    const d = buildSimDashboard([stat()], 'A1');
    expect(d.anomalies).toHaveLength(0);
  });
});

describe('runSimDashboard（repo 集成）', () => {
  it('空库抛错提示先导入', async () => {
    const repo = new MemoryRepo();
    await expect(runSimDashboard({ repo })).rejects.toThrow(/先执行 gwd sim-import/);
  });

  it('缺省取头部账号；指定无数据账号抛错', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSimStats([stat({ showCnt: 100 })]);
    await repo.upsertSimStats([stat({ authorId: 'A2', videoId: 'x', showCnt: 9000 })]);
    const result = await runSimDashboard({ repo });
    expect(result.dashboard.authorId).toBe('A2'); // 总曝光第一
    expect(result.topAuthors[0]).toMatchObject({ authorId: 'A2', totalShow: 9000 });
    await expect(runSimDashboard({ repo, authorId: 'nobody' })).rejects.toThrow(/没有模拟数据/);
  });
});
