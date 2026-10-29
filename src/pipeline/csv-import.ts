/**
 * 候选品 CSV 导入（方案三：人工维护表格，≤5 分钟/天）。
 * - 支持中文表头（选品广场口径）与英文字段名
 * - 缺必填字段 → 整行跳过并报告（不编数据）
 * - 同一商品当天重复行 → 后行覆盖（数据修正）
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { ProductSnapshot, Trend } from '../core/types.js';
import { parseNumber } from '../util.js';

const HEADER_ALIASES: Record<string, string> = {
  '商品id': 'external_id',
  '商品编码': 'external_id',
  external_id: 'external_id',
  标题: 'title',
  商品名: 'title',
  title: 'title',
  类目: 'category',
  category: 'category',
  价格: 'price',
  price: 'price',
  佣金率: 'commission_rate',
  佣金: 'commission_rate',
  commission_rate: 'commission_rate',
  '近30天销量': 'sales_30d',
  销量: 'sales_30d',
  sales_30d: 'sales_30d',
  环比: 'mom_trend',
  趋势: 'mom_trend',
  mom_trend: 'mom_trend',
  好评率: 'review_rate',
  review_rate: 'review_rate',
  品退率: 'return_rate',
  return_rate: 'return_rate',
  商家体验分: 'merchant_score',
  体验分: 'merchant_score',
  merchant_score: 'merchant_score',
  履约: 'fulfillment',
  履约方式: 'fulfillment',
  fulfillment: 'fulfillment',
  内容友好度: 'content_friendliness',
  content_friendliness: 'content_friendliness',
  竞争度: 'competition',
  competition: 'competition',
  复购扩展性: 'repurchase',
  复购扩展: 'repurchase',
  复购: 'repurchase',
  repurchase: 'repurchase',
  主图: 'image_url',
  图片: 'image_url',
  image_url: 'image_url',
};

// 必填 = 核心商业字段（缺了打分不可信，整行跳过提醒补数据）。
// 类目/履约/品退/环比/主观三维允许为空 → 门槛 unknown + flags 提示（数据缺失不编数据）。
const REQUIRED = ['external_id', 'title', 'price', 'commission_rate', 'sales_30d', 'review_rate', 'merchant_score'] as const;

function parseTrend(raw: string | undefined): { trend: Trend; defaulted: boolean } | null {
  if (raw == null || raw.trim() === '') return null;
  const v = raw.trim().toLowerCase();
  if (['上升', 'up', '↑', '涨', 'rising'].includes(v)) return { trend: 'up', defaulted: false };
  if (['下降', 'down', '↓', '跌', 'falling'].includes(v)) return { trend: 'down', defaulted: false };
  if (['持平', 'flat', '平', '-'].includes(v)) return { trend: 'flat', defaulted: false };
  return { trend: 'flat', defaulted: true }; // 无法识别 → 按持平 + 标记
}

function parseSubjective(raw: string | undefined): number | null {
  const n = parseNumber(raw);
  if (n == null) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

export interface CsvImportResult {
  rows: ProductSnapshot[];
  errors: Array<{ line: number; message: string }>;
  stats: { total: number; valid: number; skipped: number };
}

export function parseCandidatesCsv(content: string): CsvImportResult {
  const records: Record<string, string>[] = parse(content, {
    columns: (header: string[]) => header.map((h) => HEADER_ALIASES[(h ?? '').trim().toLowerCase()] ?? (h ?? '').trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  const rows: ProductSnapshot[] = [];
  const errors: Array<{ line: number; message: string }> = [];

  records.forEach((rec, idx) => {
    const line = idx + 2; // +1 表头，+1 从 1 计
    const missing = REQUIRED.filter((f) => rec[f] == null || String(rec[f]).trim() === '');
    if (missing.length > 0) {
      errors.push({ line, message: `缺必填字段: ${missing.join(', ')}` });
      return;
    }
    const externalId = String(rec.external_id).trim();
    const title = String(rec.title).trim();
    if (!externalId || !title) {
      errors.push({ line, message: '商品ID/标题为空' });
      return;
    }
    const price = parseNumber(rec.price);
    const commissionRate = parseNumber(rec.commission_rate);
    const sales30d = parseNumber(rec.sales_30d);
    const reviewRate = parseNumber(rec.review_rate);
    const merchantScore = parseNumber(rec.merchant_score);
    if (price == null || commissionRate == null || sales30d == null || reviewRate == null || merchantScore == null) {
      errors.push({ line, message: `数值字段解析失败（价格/佣金/销量/好评率/体验分）: ${externalId}` });
      return;
    }
    const trend = parseTrend(rec.mom_trend);
    rows.push({
      externalId,
      title,
      category: rec.category?.trim() || null,
      price,
      commissionRate,
      sales30d: Math.round(sales30d),
      momTrend: trend ? trend.trend : null,
      reviewRate,
      returnRate: parseNumber(rec.return_rate),
      merchantScore,
      fulfillment: rec.fulfillment?.trim() || null,
      contentFriendliness: parseSubjective(rec.content_friendliness),
      competition: parseSubjective(rec.competition),
      repurchase: parseSubjective(rec.repurchase),
      imageUrl: rec.image_url?.trim() || null,
    });
  });

  return {
    rows,
    errors,
    stats: { total: records.length, valid: rows.length, skipped: errors.length },
  };
}

export function readCandidatesFile(path: string): CsvImportResult {
  return parseCandidatesCsv(readFileSync(path, 'utf8'));
}
