/**
 * 模拟播放事件导入（模块④ B3 第二批：内容明细下钻的数据层，零 LLM）。
 * 把 KuaiRec 2.0 的 small_matrix.csv（约 467 万行播放级观看事件）导入 sim_play_events，
 * 配合 sim_content_stats（0006 日粒度台账）做单内容下钻：完播边界 / 观看时长分布。
 *
 * 口径：watch_ratio = play_duration / video_duration（≥1 视为看完）。
 * date 列是浮点（如 20200705.0）→ parseSimPlayDate 转成 'YYYY-MM-DD'。
 *
 * 红线：source 强制 'kuairec'——模拟数据永不与真实数据混读。
 * 幂等：键 (source, video_id, user_id, watch_ts) 已存在跳过，重跑不重复。
 */
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse';
import type { Repo, SimPlayEventRow } from '../db/repo.js';
import { parseIntDate } from './sim-import.js';

/** 默认数据文件名（data/ 目录下） */
export const SIM_PLAY_FILE = 'KuaiRec 2.0__data__small_matrix.csv';

/**
 * KuaiRec date 列是浮点（'20200705.0'）→ 'YYYY-MM-DD'。
 * 复用 sim-import 的 parseIntDate 做真实日历日校验，解析失败返回 null。
 */
export function parseSimPlayDate(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  // '20200705.0' → 去掉小数点及以后；只保留前 8 位数字部分
  const intPart = v.split('.')[0] ?? '';
  return parseIntDate(intPart);
}

/** 数值列：空 / 非有限 / 负数 → null（缺失≠0，播放时长和比值未知就别猜） */
function cleanNum(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 单行 small_matrix 记录 → SimPlayEventRow；关键字段（video_id/user_id/timestamp）缺失返回 null（计 invalid） */
export function parseSimPlayRecord(rec: Record<string, string>): SimPlayEventRow | null {
  const videoId = String(rec.video_id ?? '').trim();
  const userId = String(rec.user_id ?? '').trim();
  const tsRaw = String(rec.timestamp ?? '').trim();
  const watchTs = tsRaw === '' ? NaN : Number(tsRaw);
  if (!videoId || !userId || !Number.isFinite(watchTs)) return null;
  const playDuration = cleanNum(rec.play_duration);
  const videoDuration = cleanNum(rec.video_duration);
  const ratioRaw = cleanNum(rec.watch_ratio);
  return {
    source: 'kuairec',
    videoId,
    userId,
    watchDate: parseSimPlayDate(rec.date),
    watchTs,
    watchedAt: rec.time == null || String(rec.time).trim() === '' ? null : String(rec.time).trim(),
    playDuration,
    videoDuration,
    // watch_ratio 缺失但有分母时可以自算（口径：play_duration / video_duration）
    watchRatio: ratioRaw ?? (playDuration != null && videoDuration != null && videoDuration > 0 ? playDuration / videoDuration : null),
  };
}

export interface SimPlayImportOptions {
  repo: Repo;
  /** 数据目录（默认 data/） */
  dir?: string;
  /** 最多读取行数（小样本试跑用；不填 = 全量 467 万） */
  limit?: number;
  /** 文件名覆盖（测试用） */
  file?: string;
}

export interface SimPlayImportResult {
  /** 读取的总行数（含无效） */
  total: number;
  inserted: number;
  skipped: number;
  invalid: number;
  videoCount: number;
  userCount: number;
  dateFrom: string | null;
  dateTo: string | null;
}

/** 流式导入：读 CSV → 清洗 → 分批幂等落库（467 万行按 5000/批落 PG） */
export async function runSimPlayImport(opts: SimPlayImportOptions): Promise<SimPlayImportResult> {
  const dir = opts.dir ?? 'data';
  const filePath = join(dir, opts.file ?? SIM_PLAY_FILE);
  if (!existsSync(filePath)) throw new Error(`找不到播放事件文件: ${filePath}`);

  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  const videos = new Set<string>();
  const users = new Set<string>();
  const dates: string[] = [];

  let batch: SimPlayEventRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const r = await opts.repo.upsertSimPlayEvents(batch);
    inserted += r.inserted;
    skipped += r.skipped;
    batch = [];
  };

  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }),
  );
  try {
    for await (const rec of parser as AsyncIterable<Record<string, string>>) {
      total += 1;
      const row = parseSimPlayRecord(rec);
      if (row == null) {
        invalid += 1;
      } else {
        videos.add(row.videoId);
        users.add(row.userId);
        if (row.watchDate != null) dates.push(row.watchDate);
        batch.push(row);
        if (batch.length >= 5000) await flush();
      }
      if (opts.limit != null && opts.limit > 0 && total >= opts.limit) break;
    }
  } finally {
    await flush();
    parser.destroy();
  }

  dates.sort();
  return {
    total,
    inserted,
    skipped,
    invalid,
    videoCount: videos.size,
    userCount: users.size,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
  };
}
