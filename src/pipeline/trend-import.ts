/**
 * 品类趋势背景板数据通道（模块① V3：巨量算数等外部指数人工导出；零 LLM）。
 * 把「品类-日」粒度搜索指数 CSV 导入 category_trend（source='manual'）。
 *
 * 红线：
 *   - source 强制 'manual'——外部指数只能人工导出/抄录，无爬虫无自动采集（远期池另议）
 *   - 搜索指数非负整数（千分位容忍）：负数/非数字 → 整行作废（指数是背景参考口径，不猜）
 *   - 品类/日期必填；品类名按导入原样归一（cleanText 消毒）
 *   - 趋势只作选品背景参考，不进打分——打分只认自己的表现台账（口径红线）
 * 幂等：键 (source, category, stat_date) 已存在跳过，重跑不重复。
 *
 * CSV 模板：templates/category-trend-template.csv（中文表头）。
 * 必填列：品类、日期（YYYY-MM-DD）、搜索指数。
 */
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import type { CategoryTrendRow, Repo } from '../db/repo.js';
import { cleanCount, cleanText, parseIsoDate } from '../core/text-clean.js';

/** 品类趋势来源标记（类型层锁死，无自动采集 source） */
export const CATEGORY_TREND_SOURCE = 'manual' as const;

/** 必填表头（缺一即整文件拒收，避免错列静默落库） */
export const TREND_REQUIRED_HEADERS = ['品类', '日期', '搜索指数'] as const;

/** 表头校验：必填列齐全才放行（错列早失败，不静默落错数据） */
export function validateTrendHeaders(headers: string[]): string | null {
  const missing = TREND_REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) return `CSV 缺少必填表头: ${missing.join('、')}（模板见 templates/category-trend-template.csv）`;
  return null;
}

/** 单行记录 → CategoryTrendRow（source='manual'）；关键列缺失/非法返回 null（计 invalid） */
export function parseTrendRecord(rec: Record<string, string>): CategoryTrendRow | null {
  const category = cleanText(rec['品类']);
  const statDate = parseIsoDate(rec['日期']);
  if (category == null || statDate == null) return null;

  // 搜索指数（非负整数，千分位容忍；负数/非数字 → 整行作废，不猜）
  const searchIndex = cleanCount(rec['搜索指数']);
  if (searchIndex == null) return null;

  return {
    source: CATEGORY_TREND_SOURCE, // 红线：source 由代码写死，不读 CSV
    category,
    statDate,
    searchIndex,
  };
}

export interface TrendImportOptions {
  repo: Repo;
  /** CSV 文件路径（中文表头，模板见 templates/） */
  file: string;
  /** 最多读取行数（试跑用；不填 = 全量） */
  limit?: number;
}

export interface TrendImportResult {
  total: number;
  inserted: number;
  skipped: number;
  invalid: number;
  categoryCount: number;
  dateFrom: string | null;
  dateTo: string | null;
}

/** 流式导入：读 CSV → 清洗 → 分批幂等落库（复用 real-product-import 验证过的框架） */
export async function runTrendImport(opts: TrendImportOptions): Promise<TrendImportResult> {
  if (!existsSync(opts.file)) throw new Error(`找不到 CSV 文件: ${opts.file}（模板: templates/category-trend-template.csv）`);

  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  const categories = new Set<string>();
  const dates: string[] = [];

  let batch: CategoryTrendRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const r = await opts.repo.upsertCategoryTrends(batch);
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
        const err = validateTrendHeaders(Object.keys(rec));
        if (err != null) throw new Error(err);
        headerChecked = true;
      }
      total += 1;
      const row = parseTrendRecord(rec);
      if (row == null) {
        invalid += 1;
      } else {
        categories.add(row.category);
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
    categoryCount: categories.size,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
  };
}
