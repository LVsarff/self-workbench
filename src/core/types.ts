/** 领域类型：与《AI带货工作台-场景拆解》1.1 候选品卡片对齐 */

export type Trend = 'up' | 'flat' | 'down';

/** 候选品快照（每日导入，字段与选品广场口径对应） */
export interface ProductSnapshot {
  externalId: string;
  title: string;
  category: string | null;
  price: number | null;
  /** 佣金率，百分数（如 25 表示 25%） */
  commissionRate: number | null;
  sales30d: number | null;
  momTrend: Trend | null;
  /** 好评率，百分数 */
  reviewRate: number | null;
  /** 品退率，百分数；选品广场常不展示 → null */
  returnRate: number | null;
  merchantScore: number | null;
  fulfillment: string | null;
  /** 主观三维（人工打档 1-5，MVP 进表格） */
  contentFriendliness: number | null;
  competition: number | null;
  repurchase: number | null;
  imageUrl: string | null;
}

export type GateCode =
  | 'category'
  | 'review_rate'
  | 'return_rate'
  | 'commission'
  | 'merchant_score'
  | 'fulfillment';

export interface GateResult {
  code: GateCode;
  status: 'pass' | 'fail' | 'unknown';
  detail?: string;
}

export type Grade = 'strong' | 'test' | 'drop';

export interface DimensionScores {
  commission: number;
  demand: number;
  contentFriendliness: number | null;
  competition: number | null;
  price: number;
  supplyChain: number;
  repurchase: number | null;
}

export interface ScoredProduct {
  productId: string;
  snapshot: ProductSnapshot;
  gates: GateResult[];
  gatePassed: boolean;
  /** 门槛数据缺失（unknown）的门槛项 */
  unknownGates: GateCode[];
  scores: DimensionScores;
  total: number;
  /** 主观三维齐全才参与排序（拆解篇：待评不进排序） */
  complete: boolean;
  grade: Grade | null;
  flags: string[];
}

/** 历史相似品（query_history 的预取结果，注入 Agent 输入） */
export interface SimilarProduct {
  externalId: string;
  title: string;
  category: string | null;
  total: number;
  action: string;
  batchDate: string;
}

export interface DailyListItem {
  productId: string;
  externalId: string;
  title: string;
  category: string | null;
  price: number | null;
  commissionRate: number | null;
  sales30d: number | null;
  momTrend: Trend | null;
  reviewRate: number | null;
  total: number;
  grade: Grade | null;
  gatePassed: boolean;
  complete: boolean;
  flags: string[];
  reason: string | null;
  reasonSource: 'llm' | 'template' | 'manual' | null;
  selected: boolean;
}

export interface DailyList {
  date: string;
  runId: string;
  ruleVersion: number;
  phase: string;
  status: string;
  items: DailyListItem[];
}

export const GRADE_LABEL: Record<Grade, string> = {
  strong: '强推',
  test: '可测',
  drop: '放弃',
};
