/**
 * 模拟表现数据导入（模块④ B3 第一批：数据打通层，零 LLM）。
 * 把开源数据集 KuaiRec 2.0 的「内容-日」表现表导入 sim_content_stats：
 *   - item_daily_features.csv（主表，34 万行，流式读取防内存爆）
 *   - kuairec_caption_category.csv（enrich：caption / 话题 / 一~三级类目，按 video_id 关联）
 *
 * 口径映射（对齐抖音创作者后台）：show_cnt≈曝光、play_cnt≈播放、complete_play_cnt≈完播、
 * like/comment/share/follow≈互动与涨粉。author_id≈账号、video_id≈内容。
 *
 * 红线：source 强制 'kuairec'——模拟数据永不与真实数据混读。
 * 幂等：键 (source, video_id, stat_date) 已存在跳过，重跑不重复。
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse';
import { parse as parseSync } from 'csv-parse/sync';
import type { Repo, SimContentStatRow } from '../db/repo.js';

/** 默认数据文件名（data/ 目录下） */
export const SIM_DAILY_FILE = 'KuaiRec 2.0__data__item_daily_features.csv';
export const SIM_CAPTION_FILE = 'KuaiRec 2.0__data__kuairec_caption_category.csv';

/** caption 表提取的信息（enrich 用） */
export interface SimCaptionInfo {
  caption: string | null;
  topicTag: string | null;
  category: string | null;
}

/** KuaiRec 日期是 int（如 20200705）→ 'YYYY-MM-DD'；非真实日历日返回 null */
export function parseIntDate(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!/^\d{8}$/.test(v)) return null;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // 真实日历日校验（拒绝 04-31）：按 UTC 解析后逐段回比
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/** UNKNOWN / 空 / '[]'（KuaiRec 空列表字面量）→ null */
function cleanText(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (v === '' || v === '[]' || v.toUpperCase() === 'UNKNOWN') return null;
  return v;
}

/** 计数列：null/空 → 0（缺失≠未知，按无互动计） */
function cleanCount(raw: string | undefined | null): number {
  if (raw == null) return 0;
  const v = String(raw).trim();
  if (v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/** 一~三级类目拼接（跳过 UNKNOWN/空），如「颜值·颜值随拍」 */
export function joinCategory(levels: Array<string | undefined | null>): string | null {
  const parts = levels.map((l) => cleanText(l)).filter((l): l is string => l != null);
  return parts.length > 0 ? parts.join('·') : null;
}

/** 解析 caption 表全文 → Map<video_id, info>（表小，同步解析） */
export function parseCaptionCsv(content: string): Map<string, SimCaptionInfo> {
  const records: Record<string, string>[] = parseSync(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const map = new Map<string, SimCaptionInfo>();
  for (const rec of records) {
    const videoId = String(rec.video_id ?? '').trim();
    if (!videoId) continue;
    map.set(videoId, {
      caption: cleanText(rec.caption),
      topicTag: cleanText(rec.topic_tag),
      category: joinCategory([rec.first_level_category_name, rec.second_level_category_name, rec.third_level_category_name]),
    });
  }
  return map;
}

/** 单行 item_daily_features 记录 → SimContentStatRow；缺关键字段返回 null（计 invalid） */
export function parseItemDailyRecord(rec: Record<string, string>, captions: Map<string, SimCaptionInfo>): SimContentStatRow | null {
  const videoId = String(rec.video_id ?? '').trim();
  const authorId = String(rec.author_id ?? '').trim();
  const statDate = parseIntDate(rec.date);
  if (!videoId || !authorId || statDate == null) return null;
  const enrich = captions.get(videoId);
  const durationRaw = String(rec.video_duration ?? '').trim();
  const duration = durationRaw === '' ? null : Number(durationRaw);
  return {
    source: 'kuairec',
    videoId,
    authorId,
    statDate,
    videoType: cleanText(rec.video_type),
    uploadDt: cleanText(rec.upload_dt),
    videoDuration: duration != null && Number.isFinite(duration) && duration >= 0 ? duration : null,
    videoTagName: cleanText(rec.video_tag_name),
    showCnt: cleanCount(rec.show_cnt),
    playCnt: cleanCount(rec.play_cnt),
    completePlayCnt: cleanCount(rec.complete_play_cnt),
    likeCnt: cleanCount(rec.like_cnt),
    commentCnt: cleanCount(rec.comment_cnt),
    shareCnt: cleanCount(rec.share_cnt),
    followCnt: cleanCount(rec.follow_cnt),
    collectCnt: cleanCount(rec.collect_cnt),
    reportCnt: cleanCount(rec.report_cnt),
    caption: enrich?.caption ?? null,
    topicTag: enrich?.topicTag ?? null,
    category: enrich?.category ?? null,
  };
}

export interface SimImportOptions {
  repo: Repo;
  /** 数据目录（默认 data/） */
  dir?: string;
  /** 最多读取主表行数（小样本试跑用；不填 = 全量） */
  limit?: number;
  /** 文件名覆盖（测试用） */
  files?: { daily?: string; caption?: string };
}

export interface SimImportResult {
  /** 读取的主表总行数（含无效） */
  total: number;
  inserted: number;
  skipped: number;
  invalid: number;
  videoCount: number;
  authorCount: number;
  dateFrom: string | null;
  dateTo: string | null;
}

/** 流式导入：读 CSV → 清洗 + enrich → 分批幂等落库 */
export async function runSimImport(opts: SimImportOptions): Promise<SimImportResult> {
  const dir = opts.dir ?? 'data';
  const dailyPath = join(dir, opts.files?.daily ?? SIM_DAILY_FILE);
  const captionPath = join(dir, opts.files?.caption ?? SIM_CAPTION_FILE);
  if (!existsSync(dailyPath)) throw new Error(`找不到主表文件: ${dailyPath}`);
  if (!existsSync(captionPath)) throw new Error(`找不到 caption 表文件: ${captionPath}`);

  const captions = parseCaptionCsv(readFileSync(captionPath, 'utf8'));

  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  const videos = new Set<string>();
  const authors = new Set<string>();
  const dates: string[] = [];

  let batch: SimContentStatRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const r = await opts.repo.upsertSimStats(batch);
    inserted += r.inserted;
    skipped += r.skipped;
    batch = [];
  };

  const parser = createReadStream(dailyPath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }),
  );
  try {
    for await (const rec of parser as AsyncIterable<Record<string, string>>) {
      total += 1;
      const row = parseItemDailyRecord(rec, captions);
      if (row == null) {
        invalid += 1;
      } else {
        videos.add(row.videoId);
        authors.add(row.authorId);
        dates.push(row.statDate);
        batch.push(row);
        if (batch.length >= 1000) await flush();
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
    authorCount: authors.size,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
  };
}
