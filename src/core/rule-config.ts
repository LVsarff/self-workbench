/**
 * 规则配置（系统的"宪法"，对应 PRD A.1 门槛 + A.2 七维打分）。
 * - 结构化成配置而非写死在代码里
 * - 版本化存 rule_versions 表，人批准后生效（gwd rule apply / rollback）
 */
import { z } from 'zod';

const commissionBand = z.object({ min: z.number(), score: z.number().int() });
const demandBand = z.object({
  minSales: z.number().int(),
  requireUp: z.boolean().optional(),
  score: z.number().int(),
});
const priceBand = z.object({ min: z.number(), max: z.number(), score: z.number().int() });
const supplyBand = z.object({ minReviewRate: z.number(), score: z.number().int() });
const subjectiveMap = z.record(z.string(), z.number().int());

export const RuleConfigSchema = z.object({
  version: z.number().int().positive(),
  gates: z.object({
    bannedCategoryKeywords: z.array(z.string()),
    minReviewRate: z.number(),
    maxReturnRate: z.number(),
    minCommissionRate: z.number(),
    minMerchantScore: z.number(),
    forbiddenFulfillmentKeywords: z.array(z.string()),
  }),
  scoring: z.object({
    commission: z.array(commissionBand).min(1),
    demand: z.array(demandBand).min(1),
    price: z.array(priceBand).min(1),
    supplyChain: z.array(supplyBand).min(1),
    contentFriendliness: subjectiveMap,
    competition: subjectiveMap,
    repurchase: subjectiveMap,
    highReturnRateCap: z.number().int(),
  }),
  grading: z.object({ strongMin: z.number().int(), testMin: z.number().int() }),
  topN: z.number().int().positive(),
});

export type RuleConfig = z.infer<typeof RuleConfigSchema>;

/** 初始版本 v1：严格对应《选品判据与AI带货助手PRD》A.1 / A.2 */
export const RULE_V1: RuleConfig = {
  version: 1,
  gates: {
    bannedCategoryKeywords: ['食品', '药品', '医疗', '保健', '金融', '生鲜', '危险', '易碎', '酒'],
    minReviewRate: 85,
    maxReturnRate: 10, // TODO: 替换为分类目基准表（PRD 门槛③）
    minCommissionRate: 15, // 严格大于
    minMerchantScore: 70,
    forbiddenFulfillmentKeywords: ['货到付款', '预售'],
  },
  scoring: {
    commission: [
      { min: 30, score: 20 },
      { min: 20, score: 15 },
      { min: 15, score: 10 },
      { min: 0, score: 0 },
    ],
    demand: [
      { minSales: 1000, requireUp: true, score: 20 },
      { minSales: 1000, score: 15 },
      { minSales: 500, score: 15 },
      { minSales: 100, score: 10 },
      { minSales: 0, score: 5 },
    ],
    price: [
      { min: 19.9, max: 99, score: 10 },
      { min: 99, max: 199, score: 7 },
      { min: 0, max: 999999, score: 5 },
    ],
    supplyChain: [
      { minReviewRate: 95, score: 10 },
      { minReviewRate: 85, score: 6 },
      { minReviewRate: 0, score: 3 },
    ],
    contentFriendliness: { '5': 15, '4': 12, '3': 8, '2': 5, '1': 3 },
    competition: { '5': 15, '4': 13, '3': 10, '2': 8, '1': 5 },
    repurchase: { '5': 10, '4': 8, '3': 6, '2': 5, '1': 2 },
    highReturnRateCap: 3,
  },
  grading: { strongMin: 80, testMin: 60 },
  topN: 5,
};

const DIMENSION_MAX_KEYS = [
  'commission',
  'demand',
  'contentFriendliness',
  'competition',
  'price',
  'supplyChain',
  'repurchase',
] as const;

/** 校验规则配置：schema 之外的业务不变量（满分合计 100、主观档位 1-5 齐全等） */
export function validateBusinessRule(cfg: RuleConfig): string[] {
  const errors: string[] = [];
  const s = cfg.scoring;

  const maxOf = (arr: { score: number }[]) => Math.max(...arr.map((b) => b.score));
  const totalMax =
    maxOf(s.commission) +
    maxOf(s.demand) +
    maxOf(s.price) +
    maxOf(s.supplyChain) +
    Math.max(...Object.values(s.contentFriendliness)) +
    Math.max(...Object.values(s.competition)) +
    Math.max(...Object.values(s.repurchase));
  if (totalMax !== 100) {
    errors.push(`七个维度满分合计应为 100，当前为 ${totalMax}`);
  }

  for (const [name, map] of [
    ['contentFriendliness', s.contentFriendliness],
    ['competition', s.competition],
    ['repurchase', s.repurchase],
  ] as const) {
    for (const k of ['1', '2', '3', '4', '5']) {
      if (map[k] === undefined) errors.push(`主观维度 ${name} 缺少档位 ${k}`);
    }
  }

  if (cfg.grading.testMin >= cfg.grading.strongMin) {
    errors.push('grading.testMin 必须小于 strongMin');
  }
  return errors;
}

export function parseRuleConfig(json: unknown): { ok: true; config: RuleConfig } | { ok: false; errors: string[] } {
  const parsed = RuleConfigSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const business = validateBusinessRule(parsed.data);
  if (business.length > 0) return { ok: false, errors: business };
  return { ok: true, config: parsed.data };
}

/** 给 Agent 输入用的规则摘要（进上下文的是摘要，不是全量配置） */
export function ruleSummary(cfg: RuleConfig): string {
  const g = cfg.gates;
  return [
    `门槛：类目禁售关键词[${g.bannedCategoryKeywords.join('、')}]；好评率≥${g.minReviewRate}%；品退率≤${g.maxReturnRate}%（缺失记"数据缺失"）；佣金率>${g.minCommissionRate}%；商家体验分≥${g.minMerchantScore}；履约不含[${g.forbiddenFulfillmentKeywords.join('、')}]`,
    `满分构成：佣金${Math.max(...cfg.scoring.commission.map((b) => b.score))} 需求${Math.max(...cfg.scoring.demand.map((b) => b.score))} 内容友好度${Math.max(...Object.values(cfg.scoring.contentFriendliness))} 竞争度${Math.max(...Object.values(cfg.scoring.competition))} 价格带${Math.max(...cfg.scoring.price.map((b) => b.score))} 供应链${Math.max(...cfg.scoring.supplyChain.map((b) => b.score))} 复购${Math.max(...Object.values(cfg.scoring.repurchase))}（合计100）`,
    `分级：总分≥${cfg.grading.strongMin} 强推；${cfg.grading.testMin}-${cfg.grading.strongMin - 1} 可测；<${cfg.grading.testMin} 放弃`,
  ].join('\n');
}
