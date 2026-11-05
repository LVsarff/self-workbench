/**
 * B3 第二批对抗测试（验收用）：数值污染 / 除零 / 分位数越界 /
 * 幂等键碰撞（字段内 `|` 注入）/ CRLF+BOM / 极端比率。
 * 红线不变：source 强制 'kuairec'；缺失≠0（不编数据）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { parseSimPlayRecord, runSimPlayImport, SIM_PLAY_FILE } from './sim-play-import.js';
import { buildSimContentDrilldown, quantile } from './sim-content.js';
import { buildSimDashboard } from './sim-dashboard.js';
import type { SimContentStatRow, SimPlayEventRow } from '../db/repo.js';

describe('对抗：数值污染（缺失≠0，不编数据）', () => {
  function rec(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      user_id: '1',
      video_id: '1',
      play_duration: '1000',
      video_duration: '2000',
      time: '2020-07-05 00:00:00.000',
      date: '20200705.0',
      timestamp: '1593898068.378',
      watch_ratio: '0.5',
      ...overrides,
    };
  }

  it('NaN / Infinity / 1e400 溢出 / 负数 / 字符串 → 数值列记 null 不崩', () => {
    for (const bad of ['nan', 'NaN', 'inf', '-Infinity', '1e400', '-5', 'abc', '12abc']) {
      const row = parseSimPlayRecord(rec({ play_duration: bad, watch_ratio: bad }))!;
      expect(row.playDuration, `play_duration=${bad}`).toBeNull();
      expect(row.watchRatio, `watch_ratio=${bad}`).toBeNull();
    }
  });

  it('timestamp 污染（NaN/溢出/空）→ 整行 invalid，不落库', () => {
    for (const bad of ['', 'abc', 'nan', '1e400']) {
      expect(parseSimPlayRecord(rec({ timestamp: bad })), `timestamp=${bad}`).toBeNull();
    }
  });

  it('video_duration=0 时 watch_ratio 不自算（除零保护）', () => {
    const row = parseSimPlayRecord(rec({ watch_ratio: '', video_duration: '0' }))!;
    expect(row.watchRatio).toBeNull();
  });

  it('科学计数法合法数值正常解析', () => {
    const row = parseSimPlayRecord(rec({ play_duration: '1e3', timestamp: '1.593898068378e9' }))!;
    expect(row.playDuration).toBe(1000);
    expect(row.watchTs).toBeCloseTo(1593898068.378);
  });
});

describe('对抗：quantile 越界与极端值', () => {
  it('q < 0 / q > 1 钳到边界，不产生 NaN', () => {
    expect(quantile([1, 2, 3], -1)).toBe(1);
    expect(quantile([1, 2, 3], 2)).toBe(3);
    expect(quantile([1, 2, 3], 1.5)).toBe(3);
  });

  it('极端 watch_ratio（1e9 循环播放）分位数计算不崩', () => {
    const events: SimPlayEventRow[] = [
      { source: 'kuairec', videoId: 'v', userId: 'u', watchDate: null, watchTs: 1, watchedAt: null, playDuration: 1e12, videoDuration: 6000, watchRatio: 1e9 },
      { source: 'kuairec', videoId: 'v', userId: 'u2', watchDate: null, watchTs: 2, watchedAt: null, playDuration: 100, videoDuration: 6000, watchRatio: 0.01 },
    ];
    const d = buildSimContentDrilldown(events, [], 'v');
    expect(d.playLevel.watchRatio.p50).not.toBeNaN();
    expect(d.playLevel.watchRatio.completeRatio).toBe(0.5); // 1e9 ≥ 1 完播
    expect(d.playLevel.playDuration.mean).toBeCloseTo((1e12 + 100) / 2);
  });
});

describe('对抗：幂等键字段注入（| 碰撞）', () => {
  it('videoId/userId 内含 | 不产生键碰撞（两行独立落库）', async () => {
    const repo = new MemoryRepo();
    // 旧实现 `${source}|${videoId}|${userId}|${watchTs}` 下这两行同键，会误 skip
    const a = parseSimPlayRecord({ user_id: '3|4', video_id: '1|2', timestamp: '1593898068.378' } as Record<string, string>)!;
    const b = parseSimPlayRecord({ user_id: '4', video_id: '1|2|3', timestamp: '1593898068.378' } as Record<string, string>)!;
    const r = await repo.upsertSimPlayEvents([a, b]);
    expect(r).toEqual({ inserted: 2, skipped: 0 });
    expect(await repo.getSimPlayEventsByVideo('1|2')).toHaveLength(1);
    expect(await repo.getSimPlayEventsByVideo('1|2|3')).toHaveLength(1);
  });

  it('simStats 同理：videoId 内含 | 与日期拼接不碰撞', async () => {
    const repo = new MemoryRepo();
    const mk = (videoId: string, statDate: string): SimContentStatRow => ({
      source: 'kuairec',
      videoId,
      authorId: 'A',
      statDate,
      videoType: null,
      uploadDt: null,
      videoDuration: null,
      videoTagName: null,
      showCnt: 1,
      playCnt: 1,
      completePlayCnt: 0,
      likeCnt: 0,
      commentCnt: 0,
      shareCnt: 0,
      followCnt: 0,
      collectCnt: 0,
      reportCnt: 0,
      caption: null,
      topicTag: null,
      category: null,
    });
    // 旧实现 `${source}|${videoId}|${statDate}`：'v|1'+'2020-01-02' 与 'v'+'1|2020-01-02' 同键
    const r = await repo.upsertSimStats([mk('v|1', '2020-01-02'), mk('v', '1|2020-01-02')]);
    expect(r).toEqual({ inserted: 2, skipped: 0 });
  });
});

describe('对抗：CSV 格式污染（CRLF / BOM / 引号包裹）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('CRLF + BOM + 引号包裹字段端到端可导入', async () => {
    const d = mkdtempSync(join(tmpdir(), 'gwd-sim-adv-'));
    dirs.push(d);
    // BOM 头 + CRLF 行尾 + 带引号字段（csv-parse 需正确处理）
    writeFileSync(
      join(d, SIM_PLAY_FILE),
      '\ufeffuser_id,video_id,play_duration,video_duration,time,date,timestamp,watch_ratio\r\n"1","10","500","1000","2020-07-05 00:00:00.000","20200705.0","1593898068.0","0.5"\r\n"2","10","1000","1000","2020-07-05 00:00:01.000","20200705.0","1593898069.0",""\r\n',
      'utf8',
    );
    const repo = new MemoryRepo();
    const result = await runSimPlayImport({ repo, dir: d });
    expect(result.total).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.invalid).toBe(0);
    const rows = await repo.getSimPlayEventsByVideo('10');
    expect(rows[0]!.watchRatio).toBeCloseTo(0.5);
    expect(rows[1]!.watchRatio).toBeCloseTo(1, 5); // 缺失自算 1000/1000
  });
});

describe('对抗：异常日降噪的误伤边界', () => {
  function days(shows: number[]): SimContentStatRow[] {
    return shows.map((s, i) => ({
      source: 'kuairec',
      videoId: 'v',
      authorId: 'A',
      statDate: `2020-07-${String(i + 1).padStart(2, '0')}`,
      videoType: null,
      uploadDt: null,
      videoDuration: null,
      videoTagName: null,
      showCnt: s,
      playCnt: Math.round(s / 2),
      completePlayCnt: 0,
      likeCnt: 0,
      commentCnt: 0,
      shareCnt: 0,
      followCnt: 0,
      collectCnt: 0,
      reportCnt: 0,
      caption: null,
      topicTag: null,
      category: null,
    }));
  }

  it('门槛只看前日：前日 9999 + 当日暴跌不标；隔日恢复后正常判定', () => {
    // 07-01: 9999（< 门槛，07-02 不判定）；07-02: 5000（< 门槛，07-03 不判定）；07-03: 20000 → 07-04 判定
    const d = buildSimDashboard(days([9999, 5000, 20000, 5000]), 'A');
    expect(d.anomalies).toHaveLength(1);
    expect(d.anomalies[0]).toMatchObject({ date: '2020-07-04', direction: 'down' });
  });

  it('负曝光（脏数据）不参与判定且不产生 NaN', () => {
    const d = buildSimDashboard(days([-100, 20000, 21000]), 'A');
    expect(d.anomalies).toHaveLength(0); // 07-02 前日 -100 < 门槛跳过；07-03 +5% 不达阈值
    expect(Number.isFinite(d.daily[0]!.showCnt)).toBe(true);
  });
});
