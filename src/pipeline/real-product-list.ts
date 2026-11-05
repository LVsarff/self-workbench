/**
 * 商品层表现一览（模块④ V3：按品汇总 加购 / 成交 / 佣金，零 LLM）。
 * 只读 product_performance（source='manual'），按成交金额降序。
 *
 * 红线：模拟数据源（kuairec）无商品层归因，本表只有真实通道；输出必须带 REAL_PRODUCT_DISCLAIMER。
 * 局限：product_id 与候选快照 external_id 的归因 join（表现归因闭环）是后续工作，本层只做台账与汇总。
 */
import type { ProductPerfSummary, Repo } from '../db/repo.js';

/** 商品层真实数据看板必带声明 */
export const REAL_PRODUCT_DISCLAIMER =
  '真实数据 · 本人后台手工导入（source=manual，联盟/带货后台口径；模拟数据无商品层归因，本表仅真实通道）';

export interface RealProductListOptions {
  repo: Repo;
  /** 最多展示品数（按成交金额降序取前 N） */
  top?: number;
}

export interface RealProductListResult {
  disclaimer: string;
  summary: ProductPerfSummary[];
}

export async function runRealProductList(opts: RealProductListOptions): Promise<RealProductListResult> {
  const top = opts.top ?? 20;
  const summary = await opts.repo.listProductPerformance('manual', top);
  if (summary.length === 0) {
    throw new Error('商品层真实数据还是空的，先执行 gwd real-product-import <csv>');
  }
  return { disclaimer: REAL_PRODUCT_DISCLAIMER, summary };
}
