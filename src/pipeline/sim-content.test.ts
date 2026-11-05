/**
 * 单内容下钻（B3 第二批）测试：分位数插值 / watch_ratio 完播边界 /
 * 观看时长分布 / 台账关联与样本量口径分离 / 空数据边界 / repo 集成。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import type { SimContentStatRow, SimPlayEventRow } from '../db/repo.js';
import { buildSimContentDrilldown, quantile, runSimContent } from './sim-content.js';
import { SIM_DISCLAIMER } from './sim-dashboard.js';

function event(overrides: Partial<SimPlayEventRow> = {}): SimPlayEventRow {
  return {
    source: 'kuairec',
    videoId: 'v1',
    userId: 'u1',
    watchDate: '2020-07-05',
    watchTs: 1593898068.378,
    watchedAt: '2020-07-05 05:27:48.378',
    playDuration: 4000,
    videoDuration: 6000,
    watchRatio: 4000 / 6000,
    ...overrides,
  };
}

function stat(overrides: Partial<SimContentStatRow> = {}): SimContentStatRow {
  return {
    source: 'kuairec',
    videoId: 'v1',
    authorId: 'A1',
    statDate: '2020-07-05',
    videoType: 'NORMAL',
    uploadDt: '2020-06-01',
    videoDuration: 6000,
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
    topicTag: '生活',
    category: '颜值·颜值随拍',
    ...overrides,
  };
}

describe('quantile（线性插值分位数）', () => {
  it('命中元素直接取值', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
  });

  it('边界与空数组', () => {
    expect(quantile([1, 2, 3], 0)).toBe(1);
    expect(quantile([1, 2, 3], 1)).toBe(3);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('buildSimContentDrilldown（纯计算）', () => {
  it('watch_ratio 分位数 + 完播占比 + 样本量口径', () => {
    // 5 个样本：0.3 / 0.5 / 1.0 / 1.2 / 2.0 → 完播 3/5 = 0.6
    const events = [
      event({ userId: 'u1', playDuration: 3000, watchRatio: 0.3 }),
      event({ userId: 'u2', playDuration: 5000, watchRatio: 0.5 }),
      event({ userId: 'u3', playDuration: 6000, watchRatio: 1.0 }),
      event({ userId: 'u4', playDuration: 7200, watchRatio: 1.2 }), // 循环播放 >1 合法
      event({ userId: 'u5', playDuration: 12000, watchRatio: 2.0 }),
    ];
    const d = buildSimContentDrilldown(events, [stat()], 'v1');
    expect(d.disclaimer).toBe(SIM_DISCLAIMER);
    expect(d.videoId).toBe('v1');
    expect(d.authorId).toBe('A1');
    expect(d.caption).toBe('测试文案');
    expect(d.playLevel.sampleCount).toBe(5);
    expect(d.playLevel.userCount).toBe(5);
    expect(d.playLevel.watchRatio.p50).toBe(1.0);
    expect(d.playLevel.watchRatio.p90).toBeCloseTo(1.68); // 线性插值：1.2 + 0.8 * 0.6
    expect(d.playLevel.watchRatio.completeRatio).toBe(0.6);
    expect(d.playLevel.watchRatio.ratioSampleCount).toBe(5);
    // 观看时长分布
    expect(d.playLevel.playDuration.p50).toBe(6000);
    expect(d.playLevel.playDuration.mean).toBe(33200 / 5);
  });

  it('台账汇总与播放级样本分开呈现，不混用', () => {
    const d = buildSimContentDrilldown(
      [event({ userId: 'u1' })],
      [stat({ statDate: '2020-07-05' }), stat({ statDate: '2020-07-06', showCnt: 2000, playCnt: 1000, completePlayCnt: 500 })],
      'v1',
    );
    expect(d.stats.days).toBe(2);
    expect(d.stats.showCnt).toBe(3000); // 台账口径
    expect(d.stats.completeRate).toBeCloseTo(800 / 1500);
    expect(d.playLevel.sampleCount).toBe(1); // 播放级样本口径（≠ 台账播放量）
    expect(d.daily).toHaveLength(2);
  });

  it('空事件 + 有台账：playLevel 归零不崩，台账照常输出', () => {
    const d = buildSimContentDrilldown([], [stat()], 'v1');
    expect(d.playLevel.sampleCount).toBe(0);
    expect(d.playLevel.watchRatio.completeRatio).toBeNull();
    expect(d.playLevel.watchRatio.p50).toBeNull();
    expect(d.playLevel.playDuration.mean).toBeNull();
    expect(d.stats.playCnt).toBe(500);
  });

  it('watch_ratio 全缺失：完播占比 null，ratioSampleCount 为 0', () => {
    const d = buildSimContentDrilldown([event({ watchRatio: null })], [], 'v1');
    expect(d.playLevel.sampleCount).toBe(1);
    expect(d.playLevel.watchRatio.ratioSampleCount).toBe(0);
    expect(d.playLevel.watchRatio.completeRatio).toBeNull();
  });

  it('日期范围取 watch_date 升序首尾', () => {
    const d = buildSimContentDrilldown([
      event({ watchDate: '2020-07-06' }),
      event({ watchDate: '2020-07-05' }),
      event({ watchDate: null }),
    ], [], 'v1');
    expect(d.playLevel.dateFrom).toBe('2020-07-05');
    expect(d.playLevel.dateTo).toBe('2020-07-06');
  });
});

describe('runSimContent（repo 集成）', () => {
  it('内容完全无数据抛错', async () => {
    const repo = new MemoryRepo();
    await expect(runSimContent({ repo, videoId: 'v1' })).rejects.toThrow(/没有模拟数据/);
  });

  it('事件 + 台账关联下钻', async () => {
    const repo = new MemoryRepo();
    await repo.upsertSimPlayEvents([event(), event({ userId: 'u2', watchTs: 1593981600, watchRatio: 1.5, playDuration: 9000 })]);
    await repo.upsertSimStats([stat()]);
    const d = await runSimContent({ repo, videoId: 'v1' });
    expect(d.playLevel.sampleCount).toBe(2);
    expect(d.stats.days).toBe(1);
    expect(d.caption).toBe('测试文案');
  });
});
