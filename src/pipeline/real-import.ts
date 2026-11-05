/**
 * 真实表现数据导入（P0：真实账号数据通道，零 LLM）。
 * 把本人账号从抖音创作者后台导出的「账号-内容-日」表现 CSV 导入 sim_content_stats（source='manual'）。
 *
 * 红线：
 *   - source 强制 'manual'——与模拟数据（'kuairec'）通过 source 字段隔离，永不混读
 *   - 缺失值不编数：文本列缺失 → null；计数列缺失 → 0（对齐 sim 口径：缺失≠未知，按无互动计）
 *   - 真实数据无归因链路（无内容↔商品↔成交），复盘结论仅到内容表现层
 * 幂等：键 (source, video_id, stat_date) 已存在跳过，重跑不重复。
 *
 * CSV 模板：templates/real-content-stats-template.csv（中文表头）。
 * 必填列：账号ID、视频ID、日期（YYYY-MM-DD）；其余列可缺省。
 */
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import type { Repo, SimContentStatRow } from '../db/repo.js';
import { cleanCount, cleanText, parseIsoDate } from '../core/text-clean.js';

/** 真实数据来源标记（与 'kuairec' 隔离） */
export const REAL_SOURCE = 'manual' as const;

/** 必填表头（缺一即整文件拒收，避免错列静默落库） */
export const REQUIRED_HEADERS = ['账号ID', '视频ID', '日期'] as const;

/** 已知可选表头（用于提示未知列，不阻断） */
const KNOWN_OPTIONAL_HEADERS = [
  '发布日期', '视频时长秒', '视频标签',
  '曝光数', '播放数', '完播数', '点赞数', '评论数', '分享数', '涨粉数', '收藏数',
  '标题', '话题', '类目',
] as const;

/** 表头校验：必填列齐全才放行（错列早失败，不静默落错数据） */
export function validateHeaders(headers: string[]): string | null {
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) return `CSV 缺少必填表头: ${missing.join('、')}（模板见 templates/real-content-stats-template.csv）`;
  return null;
}

/** 未知表头提示（不阻断，帮用户发现拼写偏差） */
export function unknownHeaders(headers: string[]): string[] {
  const known = new Set<string>([...REQUIRED_HEADERS, ...KNOWN_OPTIONAL_HEADERS]);
  return headers.filter((h) => !known.has(h));
}

/** 单行记录 → SimContentStatRow（source='manual'）；关键列缺失/非法返回 null（计 invalid） */
export function parseRealRecord(rec: Record<string, string>): SimContentStatRow | null {
  const authorId = cleanText(rec['账号ID']);
  const videoId = cleanText(rec['视频ID']);
  const statDate = parseIsoDate(rec['日期']);
  if (authorId == null || videoId == null || statDate == null) return null;

  const uploadDt = parseIsoDate(rec['发布日期']); // 非必填，格式错按缺失处理
  const durationRaw = cleanText(rec['视频时长秒']);
  const duration = durationRaw == null ? null : Number(durationRaw);

  const counts: Array<'showCnt' | 'playCnt' | 'completePlayCnt' | 'likeCnt' | 'commentCnt' | 'shareCnt' | 'followCnt' | 'collectCnt'> = [
    'showCnt', 'playCnt', 'completePlayCnt', 'likeCnt', 'commentCnt', 'shareCnt', 'followCnt', 'collectCnt',
  ];
  const headerOf: Record<string, string> = {
    showCnt: '曝光数', playCnt: '播放数', completePlayCnt: '完播数', likeCnt: '点赞数',
    commentCnt: '评论数', shareCnt: '分享数', followCnt: '涨粉数', collectCnt: '收藏数',
  };
  const cleaned: Record<string, number> = {};
  for (const key of counts) {
    const v = cleanCount(rec[headerOf[key]!]);
    if (v == null) return null; // 非法计数（负数/非数字）整行作废，不猜
    cleaned[key] = v;
  }

  return {
    source: REAL_SOURCE,
    videoId,
    authorId,
    statDate,
    videoType: null,
    uploadDt,
    videoDuration: duration != null && Number.isFinite(duration) && duration >= 0 ? duration : null,
    videoTagName: cleanText(rec['视频标签']),
    showCnt: cleaned.showCnt!,
    playCnt: cleaned.playCnt!,
    completePlayCnt: cleaned.completePlayCnt!,
    likeCnt: cleaned.likeCnt!,
    commentCnt: cleaned.commentCnt!,
    shareCnt: cleaned.shareCnt!,
    followCnt: cleaned.followCnt!,
    collectCnt: cleaned.collectCnt!,
    reportCnt: 0, // 创作者后台无举报数，恒 0（不编造）
    caption: cleanText(rec['标题']),
    topicTag: cleanText(rec['话题']),
    category: cleanText(rec['类目']),
  };
}

export interface RealImportOptions {
  repo: Repo;
  /** CSV 文件路径（中文表头，模板见 templates/） */
  file: string;
  /** 最多读取行数（试跑用；不填 = 全量） */
  limit?: number;
}

export interface RealImportResult {
  total: number;
  inserted: number;
  skipped: number;
  invalid: number;
  videoCount: number;
  authorCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  /** 未识别的表头（提示用） */
  unknown: string[];
}

/** 流式导入：读 CSV → 清洗 → 分批幂等落库（复用 sim-import 验证过的框架） */
export async function runRealImport(opts: RealImportOptions): Promise<RealImportResult> {
  if (!existsSync(opts.file)) throw new Error(`找不到 CSV 文件: ${opts.file}（模板: templates/real-content-stats-template.csv）`);

  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  const videos = new Set<string>();
  const authors = new Set<string>();
  const dates: string[] = [];
  let unknown: string[] = [];

  let batch: SimContentStatRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const r = await opts.repo.upsertSimStats(batch);
    inserted += r.inserted;
    skipped += r.skipped;
    batch = [];
  };

  const parser = createReadStream(opts.file).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true, bom: true }),
  );
  try {
    let headerChecked = false;
    for await (const rec of parser as AsyncIterable<Record<string, string>>) {
      if (!headerChecked) {
        const headers = Object.keys(rec);
        const err = validateHeaders(headers);
        if (err != null) throw new Error(err);
        unknown = unknownHeaders(headers);
        headerChecked = true;
      }
      total += 1;
      const row = parseRealRecord(rec);
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
    if (!headerChecked) throw new Error('CSV 是空的（连表头都没有）');
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
    unknown,
  };
}
