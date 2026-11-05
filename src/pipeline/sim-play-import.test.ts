/**
 * 模拟播放事件导入（B3 第二批）测试：浮点日期解析 / 字段映射与 watch_ratio 自算 /
 * 幂等落库（重跑跳过）/ limit 截断 / 端到端（临时 CSV 文件）。
 * 红线：source 必须 'kuairec'（模拟数据永不与真实数据混读）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import {
  parseSimPlayDate,
  parseSimPlayRecord,
  runSimPlayImport,
  SIM_PLAY_FILE,
} from './sim-play-import.js';

const PLAY_CSV = [
  'user_id,video_id,play_duration,video_duration,time,date,timestamp,watch_ratio',
  '14,148,4381,6067,2020-07-05 05:27:48.378,20200705.0,1593898068.378,0.7221031811438932',
  '14,183,11635,6100,2020-07-05 05:28:00.057,20200705.0,1593898080.057,1.907377049180328',
  '15,148,3000,6000,2020-07-06 10:00:00.000,20200706.0,1593981600.0,',
  '16,,100,6000,2020-07-06 10:00:01.000,20200706.0,1593981601.0,0.02',
  '17,148,100,6000,2020-07-06 10:00:02.000,baddate.0,,0.02',
].join('\n');

describe('parseSimPlayDate（浮点日期 → YYYY-MM-DD）', () => {
  it('去掉小数部分后按真实日历日解析', () => {
    expect(parseSimPlayDate('20200705.0')).toBe('2020-07-05');
    expect(parseSimPlayDate('20201231.0')).toBe('2020-12-31');
  });

  it('非法输入返回 null（不抛错）', () => {
    expect(parseSimPlayDate('')).toBeNull();
    expect(parseSimPlayDate('bad.0')).toBeNull();
    expect(parseSimPlayDate('20200431.0')).toBeNull(); // 4 月 31 日
    expect(parseSimPlayDate(undefined)).toBeNull();
  });
});

describe('parseSimPlayRecord（字段映射 + 空值边界）', () => {
  function rec(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      user_id: '14',
      video_id: '148',
      play_duration: '4381',
      video_duration: '6067',
      time: '2020-07-05 05:27:48.378',
      date: '20200705.0',
      timestamp: '1593898068.378',
      watch_ratio: '0.7221',
      ...overrides,
    };
  }

  it('完整映射：source 红线 / 浮点日期 / watch_ts 数值化', () => {
    const row = parseSimPlayRecord(rec())!;
    expect(row.source).toBe('kuairec'); // 红线：source 强制标记
    expect(row.videoId).toBe('148');
    expect(row.userId).toBe('14');
    expect(row.watchDate).toBe('2020-07-05');
    expect(row.watchTs).toBeCloseTo(1593898068.378);
    expect(row.watchedAt).toBe('2020-07-05 05:27:48.378');
    expect(row.playDuration).toBe(4381);
    expect(row.videoDuration).toBe(6067);
    expect(row.watchRatio).toBeCloseTo(0.7221);
  });

  it('watch_ratio 缺失但有时长 → 自算 play_duration / video_duration', () => {
    const row = parseSimPlayRecord(rec({ watch_ratio: '' }))!;
    expect(row.watchRatio).not.toBeNull();
    expect(row.watchRatio!).toBeCloseTo(4381 / 6067, 5);
  });

  it('时长缺失 → null（缺失≠0，不猜）', () => {
    const row = parseSimPlayRecord(rec({ play_duration: '', video_duration: '' }))!;
    expect(row.playDuration).toBeNull();
    expect(row.videoDuration).toBeNull();
  });

  it('缺关键字段（video_id/user_id/timestamp）→ null（计 invalid）', () => {
    expect(parseSimPlayRecord(rec({ video_id: '' }))).toBeNull();
    expect(parseSimPlayRecord(rec({ user_id: '' }))).toBeNull();
    expect(parseSimPlayRecord(rec({ timestamp: '' }))).toBeNull();
    expect(parseSimPlayRecord(rec({ timestamp: 'abc' }))).toBeNull();
  });
});

describe('upsertSimPlayEvents 幂等（MemoryRepo）', () => {
  it('重跑跳过已存在（source|video|user|watch_ts 键）', async () => {
    const repo = new MemoryRepo();
    const row = parseSimPlayRecord({ user_id: '14', video_id: '148', timestamp: '1593898068.378' } as Record<string, string>)!;
    const first = await repo.upsertSimPlayEvents([row]);
    expect(first).toEqual({ inserted: 1, skipped: 0 });
    const second = await repo.upsertSimPlayEvents([row]);
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    expect(await repo.getSimPlayEventsByVideo('148')).toHaveLength(1);
  });
});

describe('runSimPlayImport 端到端（临时文件）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeDataDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'gwd-sim-play-'));
    dirs.push(d);
    writeFileSync(join(d, SIM_PLAY_FILE), PLAY_CSV);
    return d;
  }

  it('导入 → 清洗落库 → 重跑全跳过（幂等）', async () => {
    const repo = new MemoryRepo();
    const dir = makeDataDir();
    const first = await runSimPlayImport({ repo, dir });
    expect(first.total).toBe(5);
    expect(first.inserted).toBe(3); // video_id 空 / timestamp 空的两行 invalid
    expect(first.skipped).toBe(0);
    expect(first.invalid).toBe(2);
    expect(first.videoCount).toBe(2);
    expect(first.userCount).toBe(2); // 14 / 15（16 行 video_id 空、17 行 timestamp 空，均 invalid）
    expect(first.dateFrom).toBe('2020-07-05');
    expect(first.dateTo).toBe('2020-07-06');

    const rows = await repo.getSimPlayEventsByVideo('148');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.watchTs)).toEqual([1593898068.378, 1593981600]); // watch_ts 升序
    expect(rows[0]!.watchRatio).not.toBeNull();
    expect(rows[1]!.watchRatio).toBeCloseTo(0.5, 5); // 3000/6000 自算

    const second = await runSimPlayImport({ repo, dir });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
    expect((await repo.getSimPlayEventsByVideo('148'))).toHaveLength(2); // 无重复
  });

  it('limit 截断读取行数', async () => {
    const repo = new MemoryRepo();
    const dir = makeDataDir();
    const result = await runSimPlayImport({ repo, dir, limit: 2 });
    expect(result.total).toBe(2);
    expect(result.inserted).toBe(2);
  });

  it('缺文件抛错（入口校验）', async () => {
    const repo = new MemoryRepo();
    await expect(runSimPlayImport({ repo, dir: 'not-exist-dir' })).rejects.toThrow(/找不到播放事件文件/);
  });
});
