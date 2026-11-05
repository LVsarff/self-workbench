/** 内存仓储：测试 + `gwd demo`（无 DB 一键跑通全流程）。语义与 PgRepo 一致（幂等、append-only 约定）。 */
import type { RuleConfig } from '../core/rule-config.js';
import type { DailyList, DailyListItem, ProductSnapshot, SimilarProduct, Trend } from '../core/types.js';
import type { AgentReason } from '../core/template-reason.js';
import type {
  ContentDecisionInput,
  ContentDecisionRow,
  ContentDraftInput,
  ContentDraftRow,
  DecisionRow,
  ImportResult,
  LlmLogEntry,
  PublishRecordInput,
  PublishRecordRow,
  ReasonRow,
  Repo,
  ResearchInput,
  ResearchRow,
  RunRecord,
  ScoreRecordRow,
  SimAuthorOverview,
  SimContentStatRow,
  SimSource,
  SimPlayEventRow,
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
  private contentDrafts = new Map<string, ContentDraftRow>(); // `${productId}|${platform}`
  private contentDecisions: ContentDecisionRow[] = [];
  private publishRecords = new Map<string, PublishRecordRow>(); // id → row
  private researches = new Map<string, ResearchRow>(); // productId → row（一品一份）
  private simStats = new Map<string, SimContentStatRow>(); // JSON.stringify([source,videoId,statDate]) → row（幂等键；数组序列化防字段内 `|` 碰撞）
  private simPlayEvents = new Map<string, SimPlayEventRow>(); // JSON.stringify([source,videoId,userId,watchTs]) → row（幂等键，同上）
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

  async findProductIdByExternalId(externalId: string): Promise<string | null> {
    return this.productsByExternal.get(externalId) ?? null;
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

  // —— 内容草稿（模块② B1）——
  async saveContentDrafts(rows: ContentDraftInput[]): Promise<void> {
    for (const r of rows) {
      const key = `${r.productId}|${r.platform}`;
      const prior = this.contentDrafts.get(key);
      const product = this.products.get(r.productId);
      // join 回填 externalId/title（与 PgRepo 查询语义一致）
      this.contentDrafts.set(key, {
        ...r,
        id: prior?.id ?? nextId('draft'),
        externalId: product?.externalId ?? prior?.externalId ?? '',
        title: product?.title ?? prior?.title ?? '',
        createdAt: new Date().toISOString(),
      });
    }
  }

  async getContentDrafts(date: string): Promise<ContentDraftRow[]> {
    return [...this.contentDrafts.values()]
      .filter((d) => d.batchDate === date)
      .sort((a, b) => a.externalId.localeCompare(b.externalId) || a.platform.localeCompare(b.platform));
  }

  async getRecentContentDrafts(since: string, before: string): Promise<ContentDraftRow[]> {
    return [...this.contentDrafts.values()]
      .filter((d) => d.batchDate >= since && d.batchDate < before && (d.status === 'draft' || d.status === 'confirmed') && d.content !== null)
      .sort((a, b) => (a.batchDate < b.batchDate ? 1 : a.batchDate > b.batchDate ? -1 : a.externalId.localeCompare(b.externalId)));
  }

  async applyContentDecision(decision: ContentDecisionInput): Promise<void> {
    const draft = [...this.contentDrafts.values()].find((d) => d.id === decision.draftId);
    if (!draft) throw new Error(`内容草稿不存在: ${decision.draftId}`);
    draft.status = decision.action; // 状态推进与决策同点落库（原子语义）
    this.contentDecisions.push({ ...decision, decidedAt: new Date().toISOString() }); // append-only
  }

  async saveContentDecisions(rows: ContentDecisionInput[]): Promise<void> {
    for (const r of rows) {
      this.contentDecisions.push({ ...r, decidedAt: new Date().toISOString() }); // append-only
    }
  }

  async getContentDecisions(date: string): Promise<ContentDecisionRow[]> {
    return this.contentDecisions.filter((d) => d.batchDate === date);
  }

  // —— 发布台账（模块③ B2）——
  async createPublishRecord(rec: PublishRecordInput): Promise<PublishRecordRow> {
    const dup = [...this.publishRecords.values()].find((r) => r.draftId === rec.draftId);
    if (dup) throw new Error(`该草稿已有发布记录: ${rec.draftId}`);
    const row: PublishRecordRow = {
      ...rec,
      id: nextId('pub'),
      status: 'pending',
      publishedAt: null,
      url: null,
      aiLabeled: null,
      createdAt: new Date().toISOString(),
    };
    this.publishRecords.set(row.id, row);
    return { ...row };
  }

  async getPublishRecords(date: string): Promise<PublishRecordRow[]> {
    return [...this.publishRecords.values()]
      .filter((r) => r.batchDate === date)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async recordPublish(id: string, patch: { url: string; publishedAt: string; aiLabeled: boolean }): Promise<void> {
    const row = this.publishRecords.get(id);
    if (!row) throw new Error(`发布记录不存在: ${id}`);
    if (row.status !== 'pending') throw new Error(`发布记录已回填过（幂等拒绝）: ${id}`);
    row.status = 'published';
    row.publishedAt = patch.publishedAt;
    row.url = patch.url;
    row.aiLabeled = patch.aiLabeled;
  }

  // —— 深度调研摘要（模块① V2）——
  async getResearch(productId: string): Promise<ResearchRow | null> {
    return this.researches.get(productId) ?? null;
  }

  async saveResearch(rec: ResearchInput): Promise<void> {
    const existing = this.researches.get(rec.productId);
    this.researches.set(rec.productId, {
      id: existing?.id ?? `res-${(this.researches.size + 1).toString().padStart(3, '0')}`,
      ...rec,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  // —— 模拟表现台账（模块④ B3 第一批）——
  async upsertSimStats(rows: SimContentStatRow[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const key = JSON.stringify([r.source, r.videoId, r.statDate]);
      if (this.simStats.has(key)) {
        skipped += 1; // 幂等：已存在跳过，不覆盖（与 PgRepo on conflict do nothing 一致）
      } else {
        this.simStats.set(key, { ...r });
        inserted += 1;
      }
    }
    return { inserted, skipped };
  }

  async getSimStatsByAuthor(source: SimSource, authorId: string): Promise<SimContentStatRow[]> {
    return [...this.simStats.values()]
      .filter((r) => r.source === source && r.authorId === authorId)
      .sort((a, b) => a.statDate.localeCompare(b.statDate) || a.videoId.localeCompare(b.videoId));
  }

  async listSimAuthors(source: SimSource, limit: number): Promise<SimAuthorOverview[]> {
    const byAuthor = new Map<string, SimContentStatRow[]>();
    for (const r of this.simStats.values()) {
      if (r.source !== source) continue; // 红线：按 source 隔离，禁止混读
      const list = byAuthor.get(r.authorId) ?? [];
      list.push(r);
      byAuthor.set(r.authorId, list);
    }
    const overviews: SimAuthorOverview[] = [...byAuthor.entries()].map(([authorId, rows]) => {
      const dates = rows.map((r) => r.statDate).sort();
      return {
        authorId,
        videoCount: new Set(rows.map((r) => r.videoId)).size,
        dateFrom: dates[0]!,
        dateTo: dates[dates.length - 1]!,
        totalShow: rows.reduce((s, r) => s + r.showCnt, 0),
        totalPlay: rows.reduce((s, r) => s + r.playCnt, 0),
        totalFollow: rows.reduce((s, r) => s + r.followCnt, 0),
      };
    });
    return overviews.sort((a, b) => b.totalShow - a.totalShow || a.authorId.localeCompare(b.authorId)).slice(0, limit);
  }

  // —— 模拟播放事件（模块④ B3 第二批）——
  async upsertSimPlayEvents(rows: SimPlayEventRow[]): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const key = JSON.stringify([r.source, r.videoId, r.userId, r.watchTs]);
      if (this.simPlayEvents.has(key)) {
        skipped += 1; // 幂等：已存在跳过，不覆盖（与 PgRepo on conflict do nothing 一致）
      } else {
        this.simPlayEvents.set(key, { ...r });
        inserted += 1;
      }
    }
    return { inserted, skipped };
  }

  async getSimPlayEventsByVideo(videoId: string): Promise<SimPlayEventRow[]> {
    return [...this.simPlayEvents.values()]
      .filter((r) => r.videoId === videoId)
      .sort((a, b) => a.watchTs - b.watchTs);
  }

  async getSimStatsByVideo(source: SimSource, videoId: string): Promise<SimContentStatRow[]> {
    return [...this.simStats.values()]
      .filter((r) => r.source === source && r.videoId === videoId)
      .sort((a, b) => a.statDate.localeCompare(b.statDate));
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
