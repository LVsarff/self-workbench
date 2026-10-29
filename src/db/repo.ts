/**
 * 仓储接口：Pg 与 Memory 双实现。
 * - PgRepo：生产（PostgreSQL）
 * - MemoryRepo：测试 + `gwd demo`（无 DB 一键体验全流程）
 * 写操作全部幂等（run_id + 实体键），run 可重放不产生重复行。
 */
import type { RuleConfig } from '../core/rule-config.js';
import type { DailyList, ProductSnapshot, SimilarProduct } from '../core/types.js';
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

export interface Repo {
  // —— 规则（版本链）——
  getActiveRule(): Promise<RuleConfig | null>;
  listRuleVersions(): Promise<Array<{ version: number; status: string; changeReason: string | null; createdAt: string }>>;
  applyRuleVersion(config: RuleConfig, meta: { reason: string; approvedBy: string }): Promise<number>;
  rollbackRule(): Promise<{ from: number; to: number }>;

  // —— 导入 ——
  upsertSnapshots(rows: ProductSnapshot[], batchDate: string): Promise<ImportResult>;
  recordImportBatch(batch: { batchDate: string; sourceFile: string; rowCount: number; validCount: number; skippedCount: number; notes?: unknown }): Promise<void>;
  getSnapshotsByDate(date: string): Promise<SnapshotWithMeta[]>;

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

  // —— LLM 审计 ——
  countLlmCallsToday(): Promise<number>;
  saveLlmLog(entry: LlmLogEntry): Promise<void>;
}
