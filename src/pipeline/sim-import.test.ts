/**
 * 模拟表现数据导入（B3 第一批）测试：字段映射 / 空值边界 / enrich 关联 /
 * 幂等落库（重跑跳过）/ limit 截断 / 端到端（临时 CSV 文件）。
 * 红线：source 必须 'kuairec'（模拟数据永不与真实数据混读）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import type { SimContentStatRow } from '../db/repo.js';
import {
  joinCategory,
  parseCaptionCsv,
  parseIntDate,
  parseItemDailyRecord,
  runSimImport,
  SIM_CAPTION_FILE,
  SIM_DAILY_FILE,
} from './sim-import.js';

const CAPTION_CSV = [
  'video_id,manual_cover_text,caption,topic_tag,first_level_category_id,first_level_category_name,second_level_category_id,second_level_category_name,third_level_category_id,third_level_category_name',
  '0,UNKNOWN,精神小伙路难走,[],8,颜值,673,颜值随拍,-124,UNKNOWN',
  '1,UNKNOWN,,[],27,高新数码,-124,UNKNOWN,-124,UNKNOWN',
  '42,UNKNOWN,好物分享日常,生活,8,颜值,673,颜值随拍,900,日常分享',
].join('\n');

const DAILY_CSV = [
  'video_id,date,author_id,video_type,upload_dt,video_duration,video_tag_name,show_cnt,play_cnt,complete_play_cnt,like_cnt,comment_cnt,share_cnt,follow_cnt,collect_cnt,report_cnt',
  '0,20200705,3309,NORMAL,2020-03-30,5966.0,建筑,14665,10141,5657,573,11,2,284,,3',
  '0,20200706,3309,NORMAL,2020-03-30,5966.0,建筑,15000,11000,6000,600,20,5,300,80,0',
  '1,20200705,7777,NORMAL,2020-04-01,12000.0,美食,0,0,0,0,0,0,0,100,0',
].join('\n');

describe('parseIntDate（KuaiRec int 日期 → YYYY-MM-DD）', () => {
  it('合法 int 日期', () => {
    expect(parseIntDate('20200705')).toBe('2020-07-05');
    expect(parseIntDate('20201231')).toBe('2020-12-31');
  });

  it('非法输入返回 null（不抛错）', () => {
    expect(parseIntDate('')).toBeNull();
    expect(parseIntDate('202075')).toBeNull();
    expect(parseIntDate('20201301')).toBeNull(); // 13 月
    expect(parseIntDate('20200431')).toBeNull(); // 4 月 31 日
    expect(parseIntDate(undefined)).toBeNull();
    expect(parseIntDate('abc')).toBeNull();
  });
});

describe('joinCategory（类目拼接）', () => {
  it('跳过 UNKNOWN/空，· 连接', () => {
    expect(joinCategory(['颜值', '颜值随拍', 'UNKNOWN'])).toBe('颜值·颜值随拍');
    expect(joinCategory(['颜值', 'UNKNOWN', 'UNKNOWN'])).toBe('颜值');
  });

  it('全缺失 → null', () => {
    expect(joinCategory(['UNKNOWN', '', undefined])).toBeNull();
  });
});

describe('parseCaptionCsv', () => {
  it('按 video_id 建索引，UNKNOWN/空 → null', () => {
    const map = parseCaptionCsv(CAPTION_CSV);
    expect(map.size).toBe(3);
    expect(map.get('0')).toEqual({ caption: '精神小伙路难走', topicTag: null, category: '颜值·颜值随拍' });
    expect(map.get('1')).toEqual({ caption: null, topicTag: null, category: '高新数码' });
    expect(map.get('42')?.category).toBe('颜值·颜值随拍·日常分享');
  });
});

describe('parseItemDailyRecord（字段映射 + 空值边界）', () => {
  const captions = parseCaptionCsv(CAPTION_CSV);

  function rec(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      video_id: '0',
      date: '20200705',
      author_id: '3309',
      video_type: 'NORMAL',
      upload_dt: '2020-03-30',
      video_duration: '5966.0',
      video_tag_name: '建筑',
      show_cnt: '14665',
      play_cnt: '10141',
      complete_play_cnt: '5657',
      like_cnt: '573',
      comment_cnt: '11',
      share_cnt: '2',
      follow_cnt: '284',
      collect_cnt: '',
      report_cnt: '3',
      ...overrides,
    };
  }

  it('完整映射：日期 int→date、时长 float、计数 int、enrich 关联', () => {
    const row = parseItemDailyRecord(rec(), captions)!;
    expect(row.source).toBe('kuairec'); // 红线：source 强制标记
    expect(row.statDate).toBe('2020-07-05');
    expect(row.videoDuration).toBe(5966);
    expect(row.showCnt).toBe(14665);
    expect(row.followCnt).toBe(284);
    expect(row.reportCnt).toBe(3);
    expect(row.caption).toBe('精神小伙路难走');
    expect(row.category).toBe('颜值·颜值随拍');
  });

  it('collect_cnt 缺失（20% null 场景）→ 0，不抛错', () => {
    const row = parseItemDailyRecord(rec({ collect_cnt: '' }), captions)!;
    expect(row.collectCnt).toBe(0);
  });

  it('无 caption 记录的视频 enrich 全 null', () => {
    const row = parseItemDailyRecord(rec({ video_id: '999' }), captions)!;
    expect(row.caption).toBeNull();
    expect(row.category).toBeNull();
  });

  it('缺关键字段（video_id/author_id/坏日期）→ null', () => {
    expect(parseItemDailyRecord(rec({ video_id: '' }), captions)).toBeNull();
    expect(parseItemDailyRecord(rec({ author_id: '' }), captions)).toBeNull();
    expect(parseItemDailyRecord(rec({ date: 'bad' }), captions)).toBeNull();
  });

  it('零曝光零播放行也入库（边界：全 0 计数合法）', () => {
    const row = parseItemDailyRecord(
      rec({ video_id: '1', author_id: '7777', show_cnt: '0', play_cnt: '0', collect_cnt: '100' }),
      captions,
    )!;
    expect(row.showCnt).toBe(0);
    expect(row.playCnt).toBe(0);
  });
});

describe('upsertSimStats 幂等（MemoryRepo）', () => {
  it('重跑跳过已存在（source|video|date 键）', async () => {
    const repo = new MemoryRepo();
    const rows: SimContentStatRow[] = [
      parseItemDailyRecord({ video_id: '0', date: '20200705', author_id: '3309' } as Record<string, string>, new Map())!,
      parseItemDailyRecord({ video_id: '0', date: '20200706', author_id: '3309' } as Record<string, string>, new Map())!,
    ];
    const first = await repo.upsertSimStats(rows);
    expect(first).toEqual({ inserted: 2, skipped: 0 });
    const second = await repo.upsertSimStats(rows);
    expect(second).toEqual({ inserted: 0, skipped: 2 });
    expect((await repo.getSimStatsByAuthor('kuairec', '3309')).length).toBe(2);
  });

  it('listSimAuthors 按总曝光降序 + 汇总口径', async () => {
    const repo = new MemoryRepo();
    const mk = (videoId: string, date: string, authorId: string, show: number): SimContentStatRow =>
      parseItemDailyRecord(
        { video_id: videoId, date, author_id: authorId, show_cnt: String(show), follow_cnt: '1' } as Record<string, string>,
        new Map(),
      )!;
    await repo.upsertSimStats([mk('a', '20200705', 'A1', 100), mk('a', '20200706', 'A1', 50), mk('b', '20200705', 'B1', 500)]);
    const list = await repo.listSimAuthors('kuairec', 10);
    expect(list.map((a) => a.authorId)).toEqual(['B1', 'A1']);
    expect(list[1]).toMatchObject({ videoCount: 1, totalShow: 150, totalFollow: 2, dateFrom: '2020-07-05', dateTo: '2020-07-06' });
  });
});

describe('runSimImport 端到端（临时文件）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeDataDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'gwd-sim-'));
    dirs.push(d);
    writeFileSync(join(d, SIM_DAILY_FILE), DAILY_CSV);
    writeFileSync(join(d, SIM_CAPTION_FILE), CAPTION_CSV);
    return d;
  }

  it('导入 → enrich 落库 → 重跑全跳过（幂等）', async () => {
    const repo = new MemoryRepo();
    const dir = makeDataDir();
    const first = await runSimImport({ repo, dir });
    expect(first.total).toBe(3);
    expect(first.inserted).toBe(3);
    expect(first.invalid).toBe(0);
    expect(first.videoCount).toBe(2);
    expect(first.authorCount).toBe(2);
    expect(first.dateFrom).toBe('2020-07-05');
    expect(first.dateTo).toBe('2020-07-06');

    const rows = await repo.getSimStatsByAuthor('kuairec', '3309');
    expect(rows.length).toBe(2);
    expect(rows[0]!.caption).toBe('精神小伙路难走'); // enrich 已关联
    expect(rows.find((r) => r.collectCnt === 0)).toBeTruthy(); // 空值清 0

    const second = await runSimImport({ repo, dir });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
    expect((await repo.getSimStatsByAuthor('kuairec', '3309')).length).toBe(2); // 无重复
  });

  it('limit 截断读取行数', async () => {
    const repo = new MemoryRepo();
    const dir = makeDataDir();
    const result = await runSimImport({ repo, dir, limit: 1 });
    expect(result.total).toBe(1);
    expect(result.inserted).toBe(1);
    expect((await repo.getSimStatsByAuthor('kuairec', '3309')).length).toBe(1);
  });

  it('缺文件抛错（入口校验）', async () => {
    const repo = new MemoryRepo();
    await expect(runSimImport({ repo, dir: 'not-exist-dir' })).rejects.toThrow(/找不到主表文件/);
  });
});
