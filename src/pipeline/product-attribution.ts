/**
 * 品级成交归因（模块⑤ V3 框架先行第五批 = 第 5/5 点收官：PRD「表现归因：哪个品好或差」的成交半张脸）。
 *
 * 归因链路：publish_records（已发布，按品聚合——首条发布日为窗口起点）
 *   join 商品层表现台账 product_performance（source='manual'，real-product-import 导入的「商品-日」行）
 *   on product_id（= 候选快照 external_id，归因 join 锚点在 0010 预埋）
 *   → 首条发布日起 N 天窗口内的累计成交 → 品级报表。
 *
 * 边界（与全仓口径一致）：
 *   - 零 LLM：纯确定性计算，读侧报表不落任何审计
 *   - 红线·无内容维度：联盟/带货后台按品导出，成交数据没有内容维度——
 *     本报表只做品级归因，**不把成交分配到单条内容**（数据不支持，均摊值仅作参考，
 *     声明强制「勿从均摊反推单条内容效果」）；单条内容的表现走 gwd attribution（内容层归因）
 *   - 双源隔离的另一种形态：product_performance 的 source 在表结构层锁死 'manual'
 *     （KuaiRec 无带货归因，模拟形态做不了——本表永远不会有模拟数据）
 *   - 小样本护栏（《场景拆解》3.4）：每条结论带样本量；品级已发布内容 <2 条
 *     → 样本不足·不参与排名语义（照样展示）
 *   - 不猜：点击 0 → 加购率/成交转化率 null（不是 0%）；未归因品逐条给原因，不静默跳过
 */
import type { Repo } from '../db/repo.js';
import type { Platform } from '../core/types.js';
import { PRODUCT_SAMPLE_MIN } from './attribution.js';

export const PRODUCT_ATTRIBUTION_DISCLAIMER =
  '真实通道 · 成交归因仅品级（联盟后台按品导出，无内容维度——成交不能分配到单条内容，均摊值仅参考勿反推单条效果；单条内容表现走 gwd attribution）';

/** 默认归因窗口：首条发布后 30 个自然日（成交转化周期长于内容表现周期；1-90 可调） */
export const DEFAULT_PRODUCT_ATTRIBUTION_DAYS = 30;

function shanghaiDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso));
}

function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

interface PerfTotals {
  clickCnt: number;
  addCartCnt: number;
  orderCnt: number;
  gmvAmount: number;
  commissionAmount: number;
}

const EMPTY_TOTALS: PerfTotals = { clickCnt: 0, addCartCnt: 0, orderCnt: 0, gmvAmount: 0, commissionAmount: 0 };

export interface ProductDealContentRef {
  platform: Platform;
  publishedAt: string;
  videoId: string | null;
}

export interface ProductDealAttributionItem {
  externalId: string;
  title: string | null;
  /** 已发布内容条数（含未回填 video_id 的） */
  contentCount: number;
  platforms: Platform[];
  /** 该品首条内容发布时间（窗口起点） */
  firstPublishedAt: string;
  /** 窗口首日（首条发布日的上海时区日期） */
  windowFrom: string;
  /** 窗口末日 */
  windowTo: string;
  /** 窗口内有数据的天数 */
  statDays: number;
  totals: PerfTotals;
  /** 加购率 = 加购/点击（点击 0 → null，不猜） */
  addCartRate: number | null;
  /** 成交转化率 = 订单/点击（点击 0 → null，不猜） */
  orderRate: number | null;
  /** 每内容均摊 GMV = GMV/已发布内容数（参考值：成交无内容维度，勿反推单条效果） */
  gmvPerContent: number | null;
  /** 样本充足（≥ PRODUCT_SAMPLE_MIN 条已发布内容）：才参与好坏排名语义 */
  sampleSufficient: boolean;
  /** 该品已发布内容清单（内容层表现走 gwd attribution，这里只给绑定关系） */
  contents: ProductDealContentRef[];
}

export interface ProductAttributionIssue {
  /** 已发布品在商品层台账完全无行（未导出该品 / 或选品池外；「无行」≠「0 成交」，如实提示） */
  noPerfData: Array<{ externalId: string; contentCount: number }>;
  /** 有历史行但窗口内 0 天（首条发布日填错？或后台尚未导出该区间） */
  outOfWindow: Array<{ externalId: string; statDays: number }>;
  /** 商品层台账有成交、发布台账无该品（选品池外直接挂车的品 / 或 external_id 两边不一致） */
  perfNoPublish: Array<{ productId: string; productTitle: string | null; gmvAmount: number }>;
}

export interface ProductAttributionReport {
  days: number;
  generatedAt: string;
  disclaimer: string;
  /** 品级成交归因（按窗口 GMV 降序；样本不足照样列出但带标记） */
  products: ProductDealAttributionItem[];
  issues: ProductAttributionIssue;
}

export interface ProductAttributionOptions {
  repo: Repo;
  /** 归因窗口天数（默认 30；1-90 整数，起点 = 该品首条内容发布日） */
  days?: number;
}

export async function buildProductAttribution(opts: ProductAttributionOptions): Promise<ProductAttributionReport> {
  const days = opts.days ?? DEFAULT_PRODUCT_ATTRIBUTION_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error(`归因窗口天数须为 1-90 的整数（收到: ${days}）`);
  }

  const published = await opts.repo.listPublishedForAttribution();

  // 按品聚合发布事实（首条发布日 = 窗口起点；品的多条内容取最早发布）
  const byProduct = new Map<
    string,
    { externalId: string; title: string | null; contents: ProductDealContentRef[]; firstPublishedAt: string }
  >();
  for (const { record, externalId, title } of published) {
    const entry =
      byProduct.get(externalId) ??
      { externalId, title, contents: [] as ProductDealContentRef[], firstPublishedAt: record.publishedAt! };
    entry.contents.push({ platform: record.platform, publishedAt: record.publishedAt!, videoId: record.videoId });
    if (record.publishedAt! < entry.firstPublishedAt) entry.firstPublishedAt = record.publishedAt!;
    byProduct.set(externalId, entry);
  }

  const products: ProductDealAttributionItem[] = [];
  const issues: ProductAttributionIssue = { noPerfData: [], outOfWindow: [], perfNoPublish: [] };

  for (const p of byProduct.values()) {
    // 红线：source 锁 'manual'（表结构 check 约束 + 查询双保险；本表永远无模拟数据）
    const allRows = await opts.repo.getProductStats('manual', p.externalId);
    if (allRows.length === 0) {
      issues.noPerfData.push({ externalId: p.externalId, contentCount: p.contents.length });
      continue;
    }

    const windowFrom = shanghaiDateOf(p.firstPublishedAt);
    const windowTo = addDays(windowFrom, days - 1);
    const rows = allRows.filter((r) => r.statDate >= windowFrom && r.statDate <= windowTo);
    if (rows.length === 0) {
      issues.outOfWindow.push({ externalId: p.externalId, statDays: allRows.length });
      continue;
    }

    const totals: PerfTotals = rows.reduce(
      (acc, r) => ({
        clickCnt: acc.clickCnt + r.clickCnt,
        addCartCnt: acc.addCartCnt + r.addCartCnt,
        orderCnt: acc.orderCnt + r.orderCnt,
        gmvAmount: Math.round((acc.gmvAmount + r.gmvAmount) * 100) / 100, // 金额累加回两位小数（对账口径不丢分）
        commissionAmount: Math.round((acc.commissionAmount + r.commissionAmount) * 100) / 100,
      }),
      EMPTY_TOTALS,
    );

    products.push({
      externalId: p.externalId,
      title: p.title,
      contentCount: p.contents.length,
      platforms: [...new Set(p.contents.map((c) => c.platform))].sort(),
      firstPublishedAt: p.firstPublishedAt,
      windowFrom,
      windowTo,
      statDays: rows.length,
      totals,
      addCartRate: totals.clickCnt === 0 ? null : totals.addCartCnt / totals.clickCnt,
      orderRate: totals.clickCnt === 0 ? null : totals.orderCnt / totals.clickCnt,
      gmvPerContent: p.contents.length === 0 ? null : Math.round((totals.gmvAmount / p.contents.length) * 100) / 100,
      sampleSufficient: p.contents.length >= PRODUCT_SAMPLE_MIN,
      contents: p.contents.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.platform.localeCompare(b.platform)),
    });
  }

  products.sort((a, b) => b.totals.gmvAmount - a.totals.gmvAmount || a.externalId.localeCompare(b.externalId));

  // 反向核对：后台有成交、发布台账无该品（数据源不匹配，不静默吞）
  const perfAll = await opts.repo.listProductPerformance('manual', 100_000);
  const publishedIds = new Set(byProduct.keys());
  for (const s of perfAll) {
    if (!publishedIds.has(s.productId)) {
      issues.perfNoPublish.push({ productId: s.productId, productTitle: s.productTitle, gmvAmount: s.gmvAmount });
    }
  }

  return {
    days,
    generatedAt: new Date().toISOString(),
    disclaimer: PRODUCT_ATTRIBUTION_DISCLAIMER,
    products,
    issues,
  };
}
