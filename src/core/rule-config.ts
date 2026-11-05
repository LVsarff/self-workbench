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
/** 分类目品退率基准（PRD 门槛③"符合类目准入标准"）：类目文本含 keyword 即套用该阈值 */
const returnRateBenchmark = z.object({ keyword: z.string().min(1), maxReturnRate: z.number().positive() });
const subjectiveMap = z.record(z.string(), z.number().int());

export const RuleConfigSchema = z.object({
  version: z.number().int().positive(),
  gates: z.object({
    bannedCategoryKeywords: z.array(z.string()),
    minReviewRate: z.number(),
    /** 默认品退率阈值（未命中任何分类目基准时套用） */
    maxReturnRate: z.number(),
    /** 可选：兼容未含基准表的存量规则版本（缺省 = 全类目统一 maxReturnRate） */
    categoryReturnRateBenchmarks: z.array(returnRateBenchmark).optional(),
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
    // 分类目品退率基准（PRD 门槛③）：初始经验值 · 未验证——高退货类目适当放宽，
    // 真实成交数据积累后经 `gwd rule apply` 走版本化流程校准，禁止系统自行改数
    categoryReturnRateBenchmarks: [
      { keyword: '服饰', maxReturnRate: 15 },
      { keyword: '女装', maxReturnRate: 15 },
      { keyword: '男装', maxReturnRate: 15 },
      { keyword: '内衣', maxReturnRate: 15 },
      { keyword: '鞋靴', maxReturnRate: 12 },
      { keyword: '珠宝', maxReturnRate: 12 },
      { keyword: '饰品', maxReturnRate: 12 },
    ],
    maxReturnRate: 10,
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

  const benchmarks = cfg.gates.categoryReturnRateBenchmarks ?? [];
  const seenKeywords = new Set<string>();
  for (const b of benchmarks) {
    if (b.maxReturnRate > 100) errors.push(`品退率基准「${b.keyword}」阈值应 ≤ 100`);
    if (seenKeywords.has(b.keyword)) errors.push(`品退率基准关键词重复：「${b.keyword}」`);
    seenKeywords.add(b.keyword);
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
    `门槛：类目禁售关键词[${g.bannedCategoryKeywords.join('、')}]；好评率≥${g.minReviewRate}%；品退率≤${g.maxReturnRate}%（分类目基准表可覆盖，缺失记"数据缺失"）；佣金率>${g.minCommissionRate}%；商家体验分≥${g.minMerchantScore}；履约不含[${g.forbiddenFulfillmentKeywords.join('、')}]`,
    `满分构成：佣金${Math.max(...cfg.scoring.commission.map((b) => b.score))} 需求${Math.max(...cfg.scoring.demand.map((b) => b.score))} 内容友好度${Math.max(...Object.values(cfg.scoring.contentFriendliness))} 竞争度${Math.max(...Object.values(cfg.scoring.competition))} 价格带${Math.max(...cfg.scoring.price.map((b) => b.score))} 供应链${Math.max(...cfg.scoring.supplyChain.map((b) => b.score))} 复购${Math.max(...Object.values(cfg.scoring.repurchase))}（合计100）`,
    `分级：总分≥${cfg.grading.strongMin} 强推；${cfg.grading.testMin}-${cfg.grading.strongMin - 1} 可测；<${cfg.grading.testMin} 放弃`,
  ].join('\n');
}
