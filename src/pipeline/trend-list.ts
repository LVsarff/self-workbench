/**
 * 品类趋势背景板查询（模块① V3：选品时的趋势背景参考；零 LLM）。
 * 按品类汇总：最新指数 / 日环比 / 区间涨跌幅，日环比降序（涨得最凶的排前面）。
 * 红线：趋势是背景参考不进打分；输出必须带数据源与口径声明（人工导出 · 参数未验证）。
 */
import type { CategoryTrendRow, CategoryTrendSummary, Repo } from '../db/repo.js';

/** 输出必带的口径声明（红线：人工导出外部指数，方法可验证、口径未验证） */
export const TREND_DISCLAIMER = '外部数据 · 巨量算数等平台人工导出（方法已验证、口径未验证）—— 仅作选品背景参考，不进打分';

/** 趋势方向标签（初始经验值 ±5%：参数未验证） */
export function trendDirection(pct: number | null): '↑' | '↓' | '→' {
  if (pct == null) return '→';
  if (pct >= 5) return '↑';
  if (pct <= -5) return '↓';
  return '→';
}

export interface TrendListOptions {
  repo: Repo;
  /** 最多展示品类数（默认 20） */
  top?: number;
  /** 指定品类时输出该品类的日序列（下钻） */
  category?: string;
}

export interface TrendListResult {
  /** 汇总一览（无 category 参数时） */
  summaries: CategoryTrendSummary[];
  /** 单品类日序列（有 category 参数时） */
  series: CategoryTrendRow[];
  disclaimers: string[];
}

export async function runTrendList(opts: TrendListOptions): Promise<TrendListResult> {
  const top = opts.top ?? 20;
  const disclaimers = [TREND_DISCLAIMER];
  if (opts.category != null) {
    const series = await opts.repo.getCategoryTrend('manual', opts.category);
    if (series.length === 0) throw new Error(`品类「${opts.category}」还没有趋势数据，先执行 gwd trend-import <csv>`);
    return { summaries: [], series, disclaimers };
  }
  const summaries = await opts.repo.listCategoryTrends('manual', top);
  if (summaries.length === 0) throw new Error('还没有品类趋势数据，先执行 gwd trend-import <csv>');
  return { summaries, series: [], disclaimers };
}
