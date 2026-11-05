/**
 * 商品层真实数据通道（模块④ V3：加购 / 成交 / 佣金，按品；零 LLM）。
 * 把联盟/带货后台人工导出的「商品-日」粒度表现 CSV 导入 product_performance（source='manual'）。
 *
 * 红线：
 *   - source 强制 'manual'——KuaiRec 无带货归因链路，商品层模拟形态做不了，
 *     本表永远只有真实通道（迁移 0010 的 check 约束 + TS 类型双重锁死）
 *   - 缺失值不编数：文本列缺失 → null；计数/金额缺失 → 0；负数或非数字 → 整行作废（金额不猜）
 *   - product_id 对应候选快照 external_id（平台商品 ID）——表现归因闭环的 join 锚点；
 *     不要求先有快照（后台导出的品可能不在选品池里，允许先记账后关联）
 * 幂等：键 (source, product_id, stat_date) 已存在跳过，重跑不重复。
 *
 * CSV 模板：templates/real-product-stats-template.csv（中文表头）。
 * 必填列：商品ID、日期（YYYY-MM-DD）；其余列可缺省。
 */
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import type { ProductPerfRow, Repo } from '../db/repo.js';
import { cleanCount, cleanMoney, cleanText, parseIsoDate } from '../core/text-clean.js';

/** 商品层来源标记（类型层锁死，模拟 source 不存在） */
export const REAL_PRODUCT_SOURCE = 'manual' as const;

/** 必填表头（缺一即整文件拒收，避免错列静默落库） */
export const PRODUCT_REQUIRED_HEADERS = ['商品ID', '日期'] as const;

/** 已知可选表头（用于提示未知列，不阻断） */
const KNOWN_PRODUCT_OPTIONAL_HEADERS = [
  '商品标题', '类目', '点击数', '加购数', '成交订单数', '成交金额（元）', '佣金（元）',
] as const;

/** 表头校验：必填列齐全才放行（错列早失败，不静默落错数据） */
export function validateProductHeaders(headers: string[]): string | null {
  const missing = PRODUCT_REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) return `CSV 缺少必填表头: ${missing.join('、')}（模板见 templates/real-product-stats-template.csv）`;
  return null;
}

/** 未知表头提示（不阻断，帮用户发现拼写偏差） */
export function unknownProductHeaders(headers: string[]): string[] {
  const known = new Set<string>([...PRODUCT_REQUIRED_HEADERS, ...KNOWN_PRODUCT_OPTIONAL_HEADERS]);
  return headers.filter((h) => !known.has(h));
}

/** 单行记录 → ProductPerfRow（source='manual'）；关键列缺失/非法返回 null（计 invalid） */
export function parseRealProductRecord(rec: Record<string, string>): ProductPerfRow | null {
  const productId = cleanText(rec['商品ID']);
  const statDate = parseIsoDate(rec['日期']);
  if (productId == null || statDate == null) return null;

  // 计数（缺失 → 0；负数/非数字 → 整行作废，不猜）
  const counts: Array<'clickCnt' | 'addCartCnt' | 'orderCnt'> = ['clickCnt', 'addCartCnt', 'orderCnt'];
  const headerOf: Record<string, string> = { clickCnt: '点击数', addCartCnt: '加购数', orderCnt: '成交订单数' };
  const cleaned: Record<string, number> = {};
  for (const key of counts) {
    const v = cleanCount(rec[headerOf[key]!]);
    if (v == null) return null;
    cleaned[key] = v;
  }

  // 金额（缺失 → 0；负数/非数字 → 整行作废——金额是佣金对账口径，宁可丢行不可错数）
  const gmv = cleanMoney(rec['成交金额（元）']);
  const commission = cleanMoney(rec['佣金（元）']);
  if (gmv == null || commission == null) return null;

  return {
    source: REAL_PRODUCT_SOURCE, // 红线：source 由代码写死，不读 CSV
    productId,
    statDate,
    productTitle: cleanText(rec['商品标题']),
    category: cleanText(rec['类目']),
    clickCnt: cleaned.clickCnt!,
    addCartCnt: cleaned.addCartCnt!,
    orderCnt: cleaned.orderCnt!,
    gmvAmount: gmv,
    commissionAmount: commission,
  };
}

export interface RealProductImportOptions {
  repo: Repo;
  /** CSV 文件路径（中文表头，模板见 templates/） */
  file: string;
  /** 最多读取行数（试跑用；不填 = 全量） */
  limit?: number;
}

export interface RealProductImportResult {
  total: number;
  inserted: number;
  skipped: number;
  invalid: number;
  productCount: number;
  dateFrom: string | null;
  dateTo: string | null;
  /** 未识别的表头（提示用） */
  unknown: string[];
}

/** 流式导入：读 CSV → 清洗 → 分批幂等落库（复用 real-import 验证过的框架） */
export async function runRealProductImport(opts: RealProductImportOptions): Promise<RealProductImportResult> {
  if (!existsSync(opts.file)) throw new Error(`找不到 CSV 文件: ${opts.file}（模板: templates/real-product-stats-template.csv）`);

  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let invalid = 0;
  const products = new Set<string>();
  const dates: string[] = [];
  let unknown: string[] = [];

  let batch: ProductPerfRow[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const r = await opts.repo.upsertProductStats(batch);
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
        const err = validateProductHeaders(headers);
        if (err != null) throw new Error(err);
        unknown = unknownProductHeaders(headers);
        headerChecked = true;
      }
      total += 1;
      const row = parseRealProductRecord(rec);
      if (row == null) {
        invalid += 1;
      } else {
        products.add(row.productId);
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
    productCount: products.size,
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    unknown,
  };
}
