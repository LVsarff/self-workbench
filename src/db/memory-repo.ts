/** 内存仓储：测试 + `gwd demo`（无 DB 一键跑通全流程）。语义与 PgRepo 一致（幂等、append-only 约定）。 */
import type { RuleConfig } from '../core/rule-config.js';
import type { DailyList, DailyListItem, ProductSnapshot, SimilarProduct, Trend } from '../core/types.js';
import type { AgentReason } from '../core/template-reason.js';
import type {
  DecisionRow,
  ImportResult,
  LlmLogEntry,
  ReasonRow,
  Repo,
  RunRecord,
  ScoreRecordRow,
  SnapshotWithMeta,
} from './repo.js';

interface ProductRow {
  id: string;
  externalId: string;
  title: string | null;
  category: string | null;
  blacklisted: boolean;
  blacklistReason: string | null;
}

interface SnapshotRow extends ProductSnapshot {
  productId: string;
  batchDate: string;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(6, '0')}`;
}

export class MemoryRepo implements Repo {
  private products = new Map<string, ProductRow>(); // id → row
  private productsByExternal = new Map<string, string>(); // externalId → productId
  private snapshots = new Map<string, SnapshotRow>(); // `${productId}|${date}`
  private runs = new Map<string, RunRecord>();
  private scores = new Map<string, ScoreRecordRow>(); // `${runId}|${productId}`
  private reasons = new Map<string, ReasonRow>(); // `${runId}|${productId}`
  private decisions: DecisionRow[] = [];
  private ruleVersions: Array<{ version: number; config: RuleConfig; status: string; changeReason: string | null; createdAt: string }> = [];
  private llmLogs: Array<LlmLogEntry & { createdAt: string }> = [];

  // —— 规则 ——
  async getActiveRule(): Promise<RuleConfig | null> {
    const active = this.ruleVersions.find((r) => r.status === 'active');
    return active ? structuredClone(active.config) : null;
  }

  async listRuleVersions() {
    return [...this.ruleVersions]
      .sort((a, b) => b.version - a.version)
      .map((r) => ({ version: r.version, status: r.status, changeReason: r.changeReason, createdAt: r.createdAt }));
  }

  async applyRuleVersion(config: RuleConfig, meta: { reason: string; approvedBy: string }): Promise<number> {
    const maxVersion = this.ruleVersions.reduce((m, r) => Math.max(m, r.version), 0);
    const version = maxVersion + 1;
    for (const r of this.ruleVersions) {
      if (r.status === 'active') r.status = 'superseded';
    }
    this.ruleVersions.push({ version, config: structuredClone(config), status: 'active', changeReason: meta.reason, createdAt: new Date().toISOString() });
    return version;
  }

  async rollbackRule(): Promise<{ from: number; to: number }> {
    const active = this.ruleVersions.find((r) => r.status === 'active');
    if (!active) throw new Error('当前没有 active 规则版本');
    const prev = [...this.ruleVersions]
      .filter((r) => r.version < active.version && r.status !== 'active')
      .sort((a, b) => b.version - a.version)[0];
    if (!prev) throw new Error(`版本 ${active.version} 之前没有可回滚的版本`);
    active.status = 'rolled_back';
    prev.status = 'active';
    return { from: active.version, to: prev.version };
  }

  // —— 导入 ——
  async upsertSnapshots(rows: ProductSnapshot[], batchDate: string): Promise<ImportResult> {
    let inserted = 0;
    let updated = 0;
    for (const s of rows) {
      let productId = this.productsByExternal.get(s.externalId);
      if (productId == null) {
        productId = nextId('prod');
        this.products.set(productId, {
          id: productId,
          externalId: s.externalId,
          title: s.title,
          category: s.category,
          blacklisted: false,
          blacklistReason: null,
        });
        this.productsByExternal.set(s.externalId, productId);
      } else {
        const p = this.products.get(productId)!;
        p.title = s.title;
        p.category = s.category;
      }
      const key = `${productId}|${batchDate}`;
      if (this.snapshots.has(key)) {
        updated += 1;
      } else {
        inserted += 1;
      }
      this.snapshots.set(key, { ...s, productId, batchDate });
    }
    return { inserted, updated };
  }

  async recordImportBatch(batch: { batchDate: string; sourceFile: string; rowCount: number; validCount: number; skippedCount: number; notes?: unknown }): Promise<void> {
    /* demo/test 不持久化导入批次明细 */
  }

  async getSnapshotsByDate(date: string): Promise<SnapshotWithMeta[]> {
    const out: SnapshotWithMeta[] = [];
    for (const s of this.snapshots.values()) {
      if (s.batchDate === date) {
        const p = this.products.get(s.productId)!;
        const { productId: _pid, batchDate: _bd, ...snapshot } = s;
        out.push({ ...snapshot, productId: s.productId, blacklisted: p.blacklisted });
      }
    }
    return out;
  }

  // —— run ——
  async createRun(batchDate: string, ruleVersion: number): Promise<string> {
    const id = nextId('run');
    this.runs.set(id, {
      id,
      batchDate,
      ruleVersion,
      phase: 'scoring',
      status: 'running',
      stats: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    return id;
  }

  async updateRun(id: string, patch: Partial<Pick<RunRecord, 'phase' | 'status' | 'stats' | 'error' | 'finishedAt'>>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run 不存在: ${id}`);
    Object.assign(run, patch);
  }

  async getLatestRun(date: string): Promise<RunRecord | null> {
    const runs = [...this.runs.values()].filter((r) => r.batchDate === date);
    if (runs.length === 0) return null;
    return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]!;
  }

  // —— 打分 / 理由 / 决策 ——
  async saveScoreRecords(rows: ScoreRecordRow[]): Promise<void> {
    for (const r of rows) this.scores.set(`${r.runId}|${r.productId}`, r);
  }

  async saveReasons(rows: ReasonRow[]): Promise<void> {
    for (const r of rows) this.reasons.set(`${r.runId}|${r.productId}`, r);
  }

  async saveDecisions(rows: DecisionRow[]): Promise<void> {
    for (const r of rows) {
      const exists = this.decisions.some((d) => d.runId === r.runId && d.productId === r.productId && d.action === r.action);
      if (!exists) this.decisions.push(r); // append-only + 幂等
    }
  }

  async getDailyList(date: string): Promise<DailyList | null> {
    const run = await this.getLatestRun(date);
    if (!run) return null;
    const items: DailyListItem[] = [];
    for (const s of this.snapshots.values()) {
      if (s.batchDate !== date) continue;
      const score = this.scores.get(`${run.id}|${s.productId}`);
      if (!score) continue;
      const reason = this.reasons.get(`${run.id}|${s.productId}`);
      const selected = this.decisions.some((d) => d.runId === run.id && d.productId === s.productId && d.action === 'selected');
      items.push({
        productId: s.productId,
        externalId: s.externalId,
        title: s.title,
        category: s.category,
        price: s.price,
        commissionRate: s.commissionRate,
        sales30d: s.sales30d,
        momTrend: s.momTrend as Trend | null,
        reviewRate: s.reviewRate,
        total: score.total,
        grade: score.grade as DailyListItem['grade'],
        gatePassed: score.gatePassed,
        complete: score.complete,
        flags: score.flags,
        reason: reason?.text ?? null,
        reasonSource: reason?.source ?? null,
        selected,
      });
    }
    items.sort((a, b) => b.total - a.total || a.externalId.localeCompare(b.externalId));
    return { date, runId: run.id, ruleVersion: run.ruleVersion, phase: run.phase, status: run.status, items };
  }

  async findSimilarProducts(categories: string[], limit: number): Promise<SimilarProduct[]> {
    const out: SimilarProduct[] = [];
    for (const d of this.decisions) {
      if (d.action !== 'selected') continue;
      const p = this.products.get(d.productId);
      const score = this.scores.get(`${d.runId}|${d.productId}`);
      if (!p || !score) continue;
      if (p.category && categories.includes(p.category)) {
        out.push({ externalId: p.externalId, title: p.title ?? '', category: p.category, total: score.total, action: d.action, batchDate: d.batchDate });
      }
    }
    return out.slice(0, limit);
  }

  // —— LLM 审计 ——
  async countLlmCallsToday(): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    return this.llmLogs.filter((l) => l.createdAt.startsWith(today)).length;
  }

  async saveLlmLog(entry: LlmLogEntry): Promise<void> {
    this.llmLogs.push({ ...entry, createdAt: new Date().toISOString() });
  }

  async close(): Promise<void> {
    // 内存实现无需释放
  }
}
