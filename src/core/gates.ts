/**
 * 六条硬性门槛（PRD A.1，一票否决）。
 * 判定结果三态：pass / fail / unknown（字段缺失 → unknown，标记"数据缺失"，不编数据）。
 */
import type { RuleConfig } from './rule-config.js';
import type { GateResult, ProductSnapshot } from './types.js';

const GATE_LABEL: Record<string, string> = {
  category: '类目合规',
  review_rate: '好评率',
  return_rate: '品退率',
  commission: '佣金率',
  merchant_score: '商家体验分',
  fulfillment: '履约方式',
};

export function gateLabel(code: string): string {
  return GATE_LABEL[code] ?? code;
}

function containsKeyword(text: string | null, keywords: string[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

export function checkGates(s: ProductSnapshot, rule: RuleConfig): GateResult[] {
  const g = rule.gates;
  const results: GateResult[] = [];

  // ① 类目合规：非禁售类目
  const bannedHit = containsKeyword(s.category, g.bannedCategoryKeywords);
  results.push(
    bannedHit
      ? { code: 'category', status: 'fail', detail: `命中禁售关键词「${bannedHit}」` }
      : { code: 'category', status: 'pass' },
  );

  // ② 好评率 ≥ 85
  results.push(
    s.reviewRate == null
      ? { code: 'review_rate', status: 'unknown', detail: '数据缺失' }
      : s.reviewRate < g.minReviewRate
        ? { code: 'review_rate', status: 'fail', detail: `${s.reviewRate}% < ${g.minReviewRate}%` }
        : { code: 'review_rate', status: 'pass' },
  );

  // ③ 品退率：MVP 全类目统一阈值（TODO 分类目基准）
  results.push(
    s.returnRate == null
      ? { code: 'return_rate', status: 'unknown', detail: '数据缺失' }
      : s.returnRate > g.maxReturnRate
        ? { code: 'return_rate', status: 'fail', detail: `${s.returnRate}% > ${g.maxReturnRate}%` }
        : { code: 'return_rate', status: 'pass' },
  );

  // ④ 佣金率 > 15（严格大于）
  results.push(
    s.commissionRate == null
      ? { code: 'commission', status: 'unknown', detail: '数据缺失' }
      : s.commissionRate <= g.minCommissionRate
        ? { code: 'commission', status: 'fail', detail: `${s.commissionRate}% ≤ ${g.minCommissionRate}%` }
        : { code: 'commission', status: 'pass' },
  );

  // ⑤ 商家体验分 ≥ 70
  results.push(
    s.merchantScore == null
      ? { code: 'merchant_score', status: 'unknown', detail: '数据缺失' }
      : s.merchantScore < g.minMerchantScore
        ? { code: 'merchant_score', status: 'fail', detail: `${s.merchantScore} < ${g.minMerchantScore}` }
        : { code: 'merchant_score', status: 'pass' },
  );

  // ⑥ 履约方式：非货到付款、非预售长周期
  const fulfillmentHit = containsKeyword(s.fulfillment, g.forbiddenFulfillmentKeywords);
  results.push(
    s.fulfillment == null
      ? { code: 'fulfillment', status: 'unknown', detail: '数据缺失' }
      : fulfillmentHit
        ? { code: 'fulfillment', status: 'fail', detail: `履约方式「${s.fulfillment}」命中「${fulfillmentHit}」` }
        : { code: 'fulfillment', status: 'pass' },
  );

  return results;
}
