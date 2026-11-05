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

// —— 模块② 内容工坊（B1 首项：双平台草稿）——

export type Platform = 'xiaohongshu' | 'douyin';

export const PLATFORM_LABEL: Record<Platform, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
};

/**
 * 草稿状态机：draft（LLM 产出待确认）→ confirmed / discarded（门③，人确认，未建）
 * needs_manual = 降级标记（无 key / LLM 失败 / 校验不过），人重写后同样走门③。
 */
export type DraftStatus = 'draft' | 'needs_manual' | 'confirmed' | 'discarded';

/** 小红书种草笔记草稿 */
export interface XiaohongshuNote {
  /** 5-20 字 */
  title: string;
  /** 150-500 字 */
  body: string;
  /** 3-8 个 */
  tags: string[];
  coverIdea: string | null;
}

/** 抖音口播脚本草稿 */
export interface DouyinScript {
  /** 前 3 秒钩子，5-30 字 */
  hook: string;
  /** 卖点段，2-4 条 */
  points: string[];
  /** 行动指令，5-50 字 */
  cta: string;
}

// —— 模块② B1 剩余：双层自检 + 门③ ——

/** L2 审查维度（content-review 任务包口径） */
export type ContentRiskType = 'absolute' | 'medical' | 'exaggeration' | 'fabricated_data' | 'other';

export interface ContentRisk {
  type: ContentRiskType;
  /** 指向原文短语的具体说明 */
  detail: string;
}

/**
 * L2 LLM 审查结论（落库形态）。
 * 语义边界（《场景拆解》2.1 #11）：L2 仅提示，不拦截 —— pass=false 时草稿仍是 draft，
 * 由门③ 人工在 5 项清单第 2 项里终判；pass=null 表示未得出结论（审查器缺失/异常）。
 */
export interface ContentReviewRecord {
  pass: boolean | null;
  risks: ContentRisk[];
  /** 审查器标识（scripted / ai-sdk:模型名） */
  model: string;
  /** pass=null 时的原因 */
  skippedReason?: string;
}

/** 历史去重命中（与新草稿相似度超阈值的近期草稿） */
export interface DuplicateHit {
  externalId: string;
  batchDate: string;
  /** 展示标题（小红书标题 / 抖音钩子） */
  title: string;
  /** 字符二元组 Jaccard 相似度 0-1 */
  similarity: number;
}
