/**
 * 七维打分（PRD A.2）。
 * 纯确定性计算（L1），不用 LLM。主观三维缺失 → null + 待评标记，不参与排序。
 */
import { checkGates, gateLabel, returnRateLimitFor } from './gates.js';
import type { RuleConfig } from './rule-config.js';
import type { DimensionScores, ProductSnapshot, ScoredProduct } from './types.js';

function scoreCommission(rate: number | null, rule: RuleConfig): number {
  if (rate == null) return 0;
  for (const band of rule.scoring.commission) {
    if (rate >= band.min) return band.score;
  }
  return 0;
}

function scoreDemand(sales: number | null, trend: string | null, rule: RuleConfig): number {
  if (sales == null) return 0;
  for (const band of rule.scoring.demand) {
    if (sales >= band.minSales && (band.requireUp ? trend === 'up' : true)) {
      return band.score;
    }
  }
  return 0;
}

function scorePrice(price: number | null, rule: RuleConfig): number {
  if (price == null) return 0;
  for (const band of rule.scoring.price) {
    if (price >= band.min && price <= band.max) return band.score;
  }
  return 0;
}

function scoreSupplyChain(
  reviewRate: number | null,
  returnRate: number | null,
  category: string | null,
  rule: RuleConfig,
): { score: number; capped: boolean } {
  if (reviewRate == null) return { score: 0, capped: false };
  let score = 0;
  for (const band of rule.scoring.supplyChain) {
    if (reviewRate >= band.minReviewRate) {
      score = band.score;
      break;
    }
  }
  // 品退率过高 → 降档（PRD："好评率95%+ 且品退率低"）；阈值与门槛③ 同口径（分类目基准 → 默认值）
  const limit = returnRateLimitFor(category, rule.gates);
  if (returnRate != null && returnRate > limit.max && score > rule.scoring.highReturnRateCap) {
    return { score: rule.scoring.highReturnRateCap, capped: true };
  }
  return { score, capped: false };
}

function subjectiveScore(value: number | null, map: Record<string, number>): number | null {
  if (value == null) return null;
  return map[String(value)] ?? null;
}

export function scoreProduct(productId: string, s: ProductSnapshot, rule: RuleConfig): ScoredProduct {
  const gates = checkGates(s, rule);
  const gatePassed = gates.every((g) => g.status !== 'fail');
  const unknownGates = gates.filter((g) => g.status === 'unknown').map((g) => g.code);

  const supply = scoreSupplyChain(s.reviewRate, s.returnRate, s.category, rule);
  const contentFriendliness = subjectiveScore(s.contentFriendliness, rule.scoring.contentFriendliness);
  const competition = subjectiveScore(s.competition, rule.scoring.competition);
  const repurchase = subjectiveScore(s.repurchase, rule.scoring.repurchase);

  const scores: DimensionScores = {
    commission: scoreCommission(s.commissionRate, rule),
    demand: scoreDemand(s.sales30d, s.momTrend, rule),
    contentFriendliness,
    competition,
    price: scorePrice(s.price, rule),
    supplyChain: supply.score,
    repurchase,
  };

  const total =
    scores.commission +
    scores.demand +
    scores.price +
    scores.supplyChain +
    (contentFriendliness ?? 0) +
    (competition ?? 0) +
    (repurchase ?? 0);

  // 排序资格 = 门槛全过 + 主观三维齐全（拆解篇：主观维未填 → 待评，不进排序）
  const complete =
    contentFriendliness != null && competition != null && repurchase != null;

  const grade = complete
    ? total >= rule.grading.strongMin
      ? 'strong'
      : total >= rule.grading.testMin
        ? 'test'
        : 'drop'
    : null;

  const flags: string[] = [];
  for (const code of unknownGates) flags.push(`数据缺失:${gateLabel(code)}`);
  const missingDims: string[] = [];
  if (contentFriendliness == null) missingDims.push('内容友好度');
  if (competition == null) missingDims.push('竞争度');
  if (repurchase == null) missingDims.push('复购扩展');
  if (missingDims.length > 0) flags.push(`待评:${missingDims.join('/')}`);
  if (s.momTrend == null && s.sales30d != null) flags.push('环比缺失按持平');
  if (supply.capped) flags.push('品退率高供应链降档');

  return {
    productId,
    snapshot: s,
    gates,
    gatePassed,
    unknownGates,
    scores,
    total,
    complete,
    grade,
    flags,
  };
}

/** 排序：门槛全过且主观三维齐全的按总分降序；其余不进排序（仅列示） */
export function rankScored(scored: ScoredProduct[]): { ranked: ScoredProduct[]; pending: ScoredProduct[] } {
  const eligible = scored.filter((p) => p.gatePassed && p.complete);
  const pending = scored.filter((p) => !(p.gatePassed && p.complete));
  eligible.sort((a, b) => b.total - a.total || a.snapshot.externalId.localeCompare(b.snapshot.externalId));
  return { ranked: eligible, pending };
}
