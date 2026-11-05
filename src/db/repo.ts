/**
 * 仓储接口：Pg 与 Memory 双实现。
 * - PgRepo：生产（PostgreSQL）
 * - MemoryRepo：测试 + `gwd demo`（无 DB 一键体验全流程）
 * 写操作全部幂等（run_id + 实体键），run 可重放不产生重复行。
 */
import type { RuleConfig } from '../core/rule-config.js';
import type {
  ContentReviewRecord,
  DailyList,
  DouyinScript,
  DuplicateHit,
  Platform,
  ProductSnapshot,
  SimilarProduct,
  XiaohongshuNote,
} from '../core/types.js';
import type { AgentReason } from '../core/template-reason.js';

export interface SnapshotWithMeta extends ProductSnapshot {
  productId: string;
  blacklisted: boolean;
}

export interface RunRecord {
  id: string;
  batchDate: string;
  ruleVersion: number;
  phase: string;
  status: string;
  stats: Record<string, unknown> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScoreRecordRow {
  runId: string;
  productId: string;
  ruleVersion: number;
  gatePassed: boolean;
  gateResults: unknown;
  dimensionScores: unknown;
  total: number;
  complete: boolean;
  grade: string | null;
  flags: string[];
}

export interface ReasonRow {
  runId: string;
  productId: string;
  text: string;
  citedFields: string[];
  source: 'llm' | 'template' | 'manual';
}

export interface DecisionRow {
  runId: string;
  batchDate: string;
  productId: string;
  action: 'selected' | 'rejected' | 'deferred';
  decidedBy: string;
  note?: string;
  ruleVersion?: number;
  totalScore?: number;
}

export interface LlmLogEntry {
  runId?: string;
  purpose: string;
  model?: string;
  skill?: string;
  input: unknown;
  output?: unknown;
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

export interface ImportResult {
  inserted: number;
  updated: number;
}

/** 内容草稿（模块② B1）：操作表行，status 随门③ 推进可更新 */
export interface ContentDraftRow {
  /** 行标识（content_decisions.draft_id 引用；upsert 不变） */
  id: string;
  runId: string;
  batchDate: string;
  productId: string;
  platform: Platform;
  status: 'draft' | 'needs_manual' | 'confirmed' | 'discarded';
  /** needs_manual 时为 null */
  content: XiaohongshuNote | DouyinScript | null;
  /** 词表硬检查命中（L1 硬语义：修不掉 → needs_manual，门③ 拒绝确认） */
  bannedHits: string[];
  /** L2 LLM 审查结论（仅提示层）；null = 未配置审查器 */
  review: ContentReviewRecord | null;
  /** 历史去重命中（超阈值；提示层，触发修订但不阻塞） */
  duplicates: DuplicateHit[];
  /** 修订循环实际使用轮数（预算 ≤2） */
  revisionCount: number;
  note: string | null;
  source: 'llm' | 'manual';
  createdAt: string;
  /** join 回填（展示用） */
  externalId: string;
  title: string;
}

export type ContentDraftInput = Omit<ContentDraftRow, 'createdAt' | 'externalId' | 'title' | 'id'>;

/** 门③ 决策流水（append-only：5 项确认清单留痕） */
export interface ContentDecisionRow {
  draftId: string;
  runId: string;
  batchDate: string;
  productId: string;
  platform: Platform;
  action: 'confirmed' | 'discarded';
  /** confirm 时的 5 项清单逐项留痕；discard 为 null */
  checklist: Array<{ item: string; pass: boolean }> | null;
  note: string | null;
  decidedBy: string;
  decidedAt: string;
}

export type ContentDecisionInput = Omit<ContentDecisionRow, 'decidedAt'>;

/** 发布台账（模块③ B2）：操作表行，pending → published（人工发布后回填；门④ 红线——系统不代发） */
export interface PublishRecordRow {
  id: string;
  draftId: string;
  runId: string;
  batchDate: string;
  productId: string;
  platform: Platform;
  status: 'pending' | 'published';
  /** 入队时按平台时段表算的建议发布时间（ISO 时间戳；展示用，非硬约束） */
  plannedAt: string | null;
  publishedAt: string | null;
  url: string | null;
  /** 回填时如实记录是否勾了平台「AI 生成」标注（null = 未回填） */
  aiLabeled: boolean | null;
  createdAt: string;
}

export type PublishRecordInput = Omit<PublishRecordRow, 'id' | 'status' | 'publishedAt' | 'url' | 'aiLabeled' | 'createdAt'>;

/** 深度调研摘要（模块① V2）：LLM 从人工抄录原文提炼，人终判 */
export interface ResearchSummary {
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  /** 舆情要点（买家整体反馈） */
  highlights: string[];
  /** 风险信号（资质/售后/合规/质量吐槽） */
  risks: string[];
  /** 可用素材点（买家真实关注点 = 内容创作素材） */
  materialPoints: string[];
}

export interface ResearchRow {
  id: string;
  productId: string;
  /** 截断后存档的原文 */
  sourceText: string;
  summary: ResearchSummary;
  runId: string | null;
  createdAt: string;
}

export type ResearchInput = Omit<ResearchRow, 'id' | 'createdAt'>;

// —— 规则提案（模块⑤ 结论回写闭环：建议 → 人批准 → 版本化生效 → 可回滚）——

/**
 * 规则变更提案（append-only 创建；status 单向一次转换 pending → approved/rejected）。
 * config 在创建与批准时都过 parseRuleConfig 校验——提案可能躺很久，批准时刻以当前链为准重新校验。
 */
export interface RuleProposalRow {
  id: string;
  /** 提案依据（审计锚点：如 sim-weekly 触发规则、人工观察） */
  basis: string;
  expectedEffect: string | null;
  config: RuleConfig;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
  /** 批准后生成的规则版本号（gwd rule rollback 的回滚锚点） */
  resultingVersion: number | null;
  createdAt: string;
}

export interface RuleProposalInput {
  basis: string;
  /** 预期效果（人判断的验收锚点），可缺省 */
  expectedEffect?: string | null;
  config: RuleConfig;
}

// —— 表现台账（模块④ B3 第一批：开源数据集 KuaiRec 2.0；P0：真实账号数据 manual）——

/**
 * 数据来源标记（红线：模拟与真实数据永不混读）。
 * - 'kuairec'：开源数据集模拟（练手沙盘，方法已验证、参数未验证）
 * - 'manual'：本人账号真实数据（创作者后台导出 CSV 手工导入）
 * 读取方必须显式传 source + 输出带数据源声明。
 */
export type SimSource = 'kuairec' | 'manual';

/** 「账号-内容-日」粒度表现行（口径对齐抖音创作者后台：show≈曝光 / play≈播放 / complete_play≈完播） */
export interface SimContentStatRow {
  source: SimSource;
  videoId: string;
  authorId: string;
  /** YYYY-MM-DD */
  statDate: string;
  videoType: string | null;
  uploadDt: string | null;
  videoDuration: number | null;
  videoTagName: string | null;
  showCnt: number;
  playCnt: number;
  completePlayCnt: number;
  likeCnt: number;
  commentCnt: number;
  shareCnt: number;
  followCnt: number;
  collectCnt: number;
  reportCnt: number;
  /** enrich：caption / 话题标签 / 一~三级类目拼接 */
  caption: string | null;
  topicTag: string | null;
  category: string | null;
}

/** 账号（作者）层汇总一览（按总曝光降序） */
export interface SimAuthorOverview {
  authorId: string;
  videoCount: number;
  dateFrom: string;
  dateTo: string;
  totalShow: number;
  totalPlay: number;
  totalFollow: number;
}

/** 播放事件粒度行（模块④ B3 第二批：KuaiRec small_matrix，内容明细下钻用） */
export interface SimPlayEventRow {
  source: SimSource;
  videoId: string;
  userId: string;
  /** YYYY-MM-DD（来自 date 列浮点，如 20200705.0；解析失败为 null） */
  watchDate: string | null;
  /** 浮点秒 epoch（timestamp 列）；幂等键组成部分，解析失败的行整体作废 */
  watchTs: number;
  /** 原始 time 字符串（保留毫秒，排查用） */
  watchedAt: string | null;
  playDuration: number | null;
  videoDuration: number | null;
  /** = play_duration / video_duration（≥1 视为看完），缺失为 null */
  watchRatio: number | null;
}

export interface Repo {
  // —— 规则（版本链）——
  getActiveRule(): Promise<RuleConfig | null>;
  listRuleVersions(): Promise<Array<{ version: number; status: string; changeReason: string | null; createdAt: string }>>;
  applyRuleVersion(config: RuleConfig, meta: { reason: string; approvedBy: string }): Promise<number>;
  rollbackRule(): Promise<{ from: number; to: number }>;

  // —— 规则提案（模块⑤ 回写闭环）——
  createRuleProposal(input: RuleProposalInput): Promise<RuleProposalRow>;
  listRuleProposals(): Promise<RuleProposalRow[]>;
  getRuleProposal(id: string): Promise<RuleProposalRow | null>;
  /**
   * 门⑤：提案决策（单向一次）。approve = 批准时刻重新校验 config → 走版本链生效 →
   * 回填 resulting_version（与版本链同事务）；reject = 仅置 rejected，active 规则不动。
   * 非 pending 状态再决策抛错（幂等拒绝，审计不留二义）。
   */
  decideRuleProposal(id: string, decision: { action: 'approve' | 'reject'; decidedBy: string }): Promise<RuleProposalRow>;

  // —— 导入 ——
  upsertSnapshots(rows: ProductSnapshot[], batchDate: string): Promise<ImportResult>;
  recordImportBatch(batch: { batchDate: string; sourceFile: string; rowCount: number; validCount: number; skippedCount: number; notes?: unknown }): Promise<void>;
  getSnapshotsByDate(date: string): Promise<SnapshotWithMeta[]>;
  /** external_id → products.id（深度调研等按品定位的入口） */
  findProductIdByExternalId(externalId: string): Promise<string | null>;

  // —— run ——
  createRun(batchDate: string, ruleVersion: number): Promise<string>;
  updateRun(id: string, patch: Partial<Pick<RunRecord, 'phase' | 'status' | 'stats' | 'error' | 'finishedAt'>>): Promise<void>;
  getLatestRun(date: string): Promise<RunRecord | null>;

  // —— 打分 / 理由 / 决策 ——
  saveScoreRecords(rows: ScoreRecordRow[]): Promise<void>;
  saveReasons(rows: ReasonRow[]): Promise<void>;
  saveDecisions(rows: DecisionRow[]): Promise<void>;
  getDailyList(date: string): Promise<DailyList | null>;
  findSimilarProducts(categories: string[], limit: number): Promise<SimilarProduct[]>;

  // —— 内容草稿（模块② B1）——
  /** 幂等：唯一键 (product_id, platform)，重跑覆盖（同快照 upsert 语义） */
  saveContentDrafts(rows: ContentDraftInput[]): Promise<void>;
  getContentDrafts(date: string): Promise<ContentDraftRow[]>;
  /** 历史草稿（去重比对 + 已确认参考）：[since, before) 窗口内 status ∈ {draft, confirmed} 且有内容，按日期倒序 */
  getRecentContentDrafts(since: string, before: string): Promise<ContentDraftRow[]>;
  /** 门③ 决策原子落库：草稿状态推进（= action）+ 决策流水同事务（防审计断链；草稿不存在抛错） */
  applyContentDecision(decision: ContentDecisionInput): Promise<void>;
  /** 门③ 决策流水（append-only） */
  saveContentDecisions(rows: ContentDecisionInput[]): Promise<void>;
  getContentDecisions(date: string): Promise<ContentDecisionRow[]>;

  // —— 发布台账（模块③ B2）——
  /** 建 pending 记录（幂等键 draft_id 已存在抛错；调用方先查重） */
  createPublishRecord(rec: PublishRecordInput): Promise<PublishRecordRow>;
  getPublishRecords(date: string): Promise<PublishRecordRow[]>;
  /** 人工发布后回填：pending → published（记录不存在 / 已回填抛错，幂等拒绝） */
  recordPublish(id: string, patch: { url: string; publishedAt: string; aiLabeled: boolean }): Promise<void>;

  // —— 深度调研摘要（模块① V2）——
  /** 一品一份（幂等键 product_id；无则 null） */
  getResearch(productId: string): Promise<ResearchRow | null>;
  /** 落库（覆盖语义：--force 重做由调用方把关；insert or update on product_id） */
  saveResearch(rec: ResearchInput): Promise<void>;

  // —— 表现台账（B3 第一批 + P0 真实数据，source 强制隔离）——
  /** 批量落库（幂等键 (source, video_id, stat_date) 已存在跳过，不覆盖） */
  upsertSimStats(rows: SimContentStatRow[]): Promise<{ inserted: number; skipped: number }>;
  /** 指定来源 + 作者（账号）的全部日粒度表现行（按 stat_date 升序；红线：必须传 source 防混读） */
  getSimStatsByAuthor(source: SimSource, authorId: string): Promise<SimContentStatRow[]>;
  /** 指定来源的账号一览（按总曝光降序；--author 缺省时挑头部账号用） */
  listSimAuthors(source: SimSource, limit: number): Promise<SimAuthorOverview[]>;

  // —— 模拟播放事件（模块④ B3 第二批）——
  /** 指定来源 + 内容的全部播放事件（按 watch_ts 升序） */
  upsertSimPlayEvents(rows: SimPlayEventRow[]): Promise<{ inserted: number; skipped: number }>;
  /** 指定内容的全部播放事件（按 watch_ts 升序；仅 kuairec 有播放级数据） */
  getSimPlayEventsByVideo(videoId: string): Promise<SimPlayEventRow[]>;
  /** 指定来源 + 内容的全部日粒度表现行（下钻时关联 caption / 类目 / 账号总量；红线：必须传 source 防混读） */
  getSimStatsByVideo(source: SimSource, videoId: string): Promise<SimContentStatRow[]>;

  // —— LLM 审计 ——
  countLlmCallsToday(): Promise<number>;
  saveLlmLog(entry: LlmLogEntry): Promise<void>;

  /** 释放连接（MemoryRepo 为空操作，PgRepo 关闭连接池） */
  close(): Promise<void>;
}
