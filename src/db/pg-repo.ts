/** PostgreSQL 仓储（node-postgres，参数化 SQL，无 ORM）。 */
import pg from 'pg';
import type { RuleConfig } from '../core/rule-config.js';
import { RuleConfigSchema, parseRuleConfig } from '../core/rule-config.js';
import type { DailyList, DailyListItem, DuplicateHit, ProductSnapshot, SimilarProduct } from '../core/types.js';
import type { Platform } from '../core/types.js';
import type {
  ContentDecisionInput,
  ContentDecisionRow,
  ContentDraftInput,
  ContentDraftRow,
  DecisionRow,
  LlmLogEntry,
  ProductPerfRow,
  ProductPerfSource,
  ProductPerfSummary,
  CategoryTrendRow,
  CategoryTrendSource,
  CategoryTrendSummary,
  PublishRecordInput,
  PublishRecordRow,
  ReasonRow,
  Repo,
  ResearchInput,
  ResearchRow,
  ResearchSummary,
  RuleProposalInput,
  RuleProposalRow,
  RunRecord,
  ScoreRecordRow,
  SimAuthorOverview,
  SimContentStatRow,
  SimPlayEventRow,
  SimSource,
  SnapshotWithMeta,
} from './repo.js';

// DATE 列（oid 1082）默认被驱动解析成本地时区的 Date 对象，String() 化后变成
// "Wed Oct 28 2026 00:00:00 GMT+0800"，无法再写回 DATE 列（confirm/discard 曾因此全坏）。
// 统一按 'YYYY-MM-DD' 原始字符串读取，与 MemoryRepo 口径一致，保证读写往返一致。
pg.types.setTypeParser(1082, (v) => v);

const num = (v: unknown): number | null => (v == null ? null : Number(v));

export class PgRepo implements Repo {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // —— 规则 ——
  async getActiveRule(): Promise<RuleConfig | null> {
    const { rows } = await this.pool.query(
      `select config from rule_versions where status = 'active' order by version desc limit 1`,
    );
    if (rows.length === 0) return null;
    return RuleConfigSchema.parse(rows[0]!.config);
  }

  async listRuleVersions() {
    const { rows } = await this.pool.query(
      `select version, status, change_reason, created_at from rule_versions order by version desc`,
    );
    return rows.map((r) => ({
      version: Number(r.version),
      status: String(r.status),
      changeReason: r.change_reason == null ? null : String(r.change_reason),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async applyRuleVersion(config: RuleConfig, meta: { reason: string; approvedBy: string }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(`select coalesce(max(version), 0) as v from rule_versions`);
      const version = Number(rows[0]!.v) + 1;
      await client.query(`update rule_versions set status = 'superseded' where status = 'active'`);
      await client.query(
        `insert into rule_versions (version, config, status, change_reason, approved_by) values ($1, $2, 'active', $3, $4)`,
        [version, JSON.stringify({ ...config, version }), meta.reason, meta.approvedBy],
      );
      await client.query('commit');
      return version;
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async rollbackRule(): Promise<{ from: number; to: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows: activeRows } = await client.query(
        `select version from rule_versions where status = 'active' order by version desc limit 1`,
      );
      const activeVersion = activeRows[0] ? Number(activeRows[0].version) : null;
      if (activeVersion == null) throw new Error('当前没有 active 规则版本');
      const { rows: prevRows } = await client.query(
        `select version from rule_versions where version < $1 order by version desc limit 1`,
        [activeVersion],
      );
      if (prevRows.length === 0) throw new Error(`版本 ${activeVersion} 之前没有可回滚的版本`);
      const prevVersion = Number(prevRows[0]!.version);
      await client.query(`update rule_versions set status = 'rolled_back' where version = $1`, [activeVersion]);
      await client.query(`update rule_versions set status = 'active' where version = $1`, [prevVersion]);
      await client.query('commit');
      return { from: activeVersion, to: prevVersion };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  // —— 规则提案（模块⑤ 回写闭环）——
  private mapProposalRow(r: Record<string, unknown>): RuleProposalRow {
    return {
      id: String(r.id),
      basis: String(r.basis),
      expectedEffect: r.expected_effect == null ? null : String(r.expected_effect),
      config: RuleConfigSchema.parse(r.config),
      status: r.status as RuleProposalRow['status'],
      decidedBy: r.decided_by == null ? null : String(r.decided_by),
      decidedAt: r.decided_at == null ? null : new Date(r.decided_at as string).toISOString(),
      resultingVersion: r.resulting_version == null ? null : Number(r.resulting_version),
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async createRuleProposal(input: RuleProposalInput): Promise<RuleProposalRow> {
    const parsed = parseRuleConfig(input.config);
    if (!parsed.ok) throw new Error(`提案 config 校验失败:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}`);
    const { rows } = await this.pool.query(
      `insert into rule_proposals (basis, expected_effect, config, status) values ($1, $2, $3, 'pending') returning *`,
      [input.basis, input.expectedEffect ?? null, JSON.stringify(parsed.config)],
    );
    return this.mapProposalRow(rows[0]!);
  }

  async listRuleProposals(): Promise<RuleProposalRow[]> {
    const { rows } = await this.pool.query(`select * from rule_proposals order by created_at desc`);
    return rows.map((r) => this.mapProposalRow(r));
  }

  async getRuleProposal(id: string): Promise<RuleProposalRow | null> {
    const { rows } = await this.pool.query(`select * from rule_proposals where id = $1`, [id]);
    return rows.length > 0 ? this.mapProposalRow(rows[0]!) : null;
  }

  async decideRuleProposal(id: string, decision: { action: 'approve' | 'reject'; decidedBy: string }): Promise<RuleProposalRow> {
    // 批准 = 版本链生效 + 提案回填，同一事务；行锁防并发双批
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(`select * from rule_proposals where id = $1 for update`, [id]);
      if (rows.length === 0) throw new Error(`提案 ${id} 不存在`);
      const row = rows[0]!;
      if (row.status !== 'pending') throw new Error(`提案 ${id} 已是 ${row.status}，不能重复决策（审计单向一次）`);
      if (decision.action === 'approve') {
        const parsed = parseRuleConfig(row.config);
        if (!parsed.ok) throw new Error(`提案 config 校验失败（批准时刻）:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}`);
        const { rows: vRows } = await client.query(`select coalesce(max(version), 0) as v from rule_versions`);
        const version = Number(vRows[0]!.v) + 1;
        await client.query(`update rule_versions set status = 'superseded' where status = 'active'`);
        await client.query(
          `insert into rule_versions (version, config, status, change_reason, approved_by) values ($1, $2, 'active', $3, $4)`,
          [version, JSON.stringify({ ...parsed.config, version }), `提案 ${id}: ${String(row.basis)}`, decision.decidedBy],
        );
        const { rows: upd } = await client.query(
          `update rule_proposals set status = 'approved', decided_by = $1, decided_at = now(), resulting_version = $2 where id = $3 returning *`,
          [decision.decidedBy, version, id],
        );
        await client.query('commit');
        return this.mapProposalRow(upd[0]!);
      }
      const { rows: upd } = await client.query(
        `update rule_proposals set status = 'rejected', decided_by = $1, decided_at = now() where id = $2 returning *`,
        [decision.decidedBy, id],
      );
      await client.query('commit');
      return this.mapProposalRow(upd[0]!);
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  // —— 导入 ——
  async upsertSnapshots(rows: ProductSnapshot[], batchDate: string): Promise<{ inserted: number; updated: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      let inserted = 0;
      let updated = 0;
      for (const s of rows) {
        const up = await client.query(
          `insert into products (external_id, title, category) values ($1, $2, $3)
           on conflict (external_id) do update set title = excluded.title, category = excluded.category, updated_at = now()
           returning id, (xmax = 0) as is_new`,
          [s.externalId, s.title, s.category],
        );
        const productId = String(up.rows[0]!.id);
        const snap = await client.query(
          `insert into product_snapshots
             (product_id, batch_date, title, category, price, commission_rate, sales_30d, mom_trend,
              review_rate, return_rate, merchant_score, fulfillment, content_friendliness, competition, repurchase, image_url, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           on conflict (product_id, batch_date) do update set
             title = excluded.title, category = excluded.category, price = excluded.price,
             commission_rate = excluded.commission_rate, sales_30d = excluded.sales_30d, mom_trend = excluded.mom_trend,
             review_rate = excluded.review_rate, return_rate = excluded.return_rate, merchant_score = excluded.merchant_score,
             fulfillment = excluded.fulfillment, content_friendliness = excluded.content_friendliness,
             competition = excluded.competition, repurchase = excluded.repurchase, image_url = excluded.image_url, raw = excluded.raw
           returning (xmax = 0) as is_new`,
          [
            productId, batchDate, s.title, s.category, s.price, s.commissionRate, s.sales30d, s.momTrend,
            s.reviewRate, s.returnRate, s.merchantScore, s.fulfillment, s.contentFriendliness, s.competition,
            s.repurchase, s.imageUrl, JSON.stringify(s),
          ],
        );
        if (snap.rows[0]!.is_new) inserted += 1;
        else updated += 1;
      }
      await client.query('commit');
      return { inserted, updated };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async recordImportBatch(batch: { batchDate: string; sourceFile: string; rowCount: number; validCount: number; skippedCount: number; notes?: unknown }): Promise<void> {
    await this.pool.query(
      `insert into import_batches (batch_date, source_file, row_count, valid_count, skipped_count, notes)
       values ($1, $2, $3, $4, $5, $6)`,
      [batch.batchDate, batch.sourceFile, batch.rowCount, batch.validCount, batch.skippedCount, batch.notes ? JSON.stringify(batch.notes) : null],
    );
  }

  async getSnapshotsByDate(date: string): Promise<SnapshotWithMeta[]> {
    const { rows } = await this.pool.query(
      `select ps.*, p.external_id, p.blacklisted
       from product_snapshots ps join products p on p.id = ps.product_id
       where ps.batch_date = $1`,
      [date],
    );
    return rows.map((r) => ({
      productId: String(r.product_id),
      blacklisted: Boolean(r.blacklisted),
      externalId: String(r.external_id),
      title: r.title ?? '',
      category: r.category ?? null,
      price: num(r.price),
      commissionRate: num(r.commission_rate),
      sales30d: r.sales_30d == null ? null : Number(r.sales_30d),
      momTrend: (r.mom_trend ?? null) as SnapshotWithMeta['momTrend'],
      reviewRate: num(r.review_rate),
      returnRate: num(r.return_rate),
      merchantScore: num(r.merchant_score),
      fulfillment: r.fulfillment ?? null,
      contentFriendliness: r.content_friendliness == null ? null : Number(r.content_friendliness),
      competition: r.competition == null ? null : Number(r.competition),
      repurchase: r.repurchase == null ? null : Number(r.repurchase),
      imageUrl: r.image_url ?? null,
    }));
  }

  async findProductIdByExternalId(externalId: string): Promise<string | null> {
    const { rows } = await this.pool.query(`select id from products where external_id = $1`, [externalId]);
    return rows.length === 0 ? null : String(rows[0]!.id);
  }

  // —— run ——
  async createRun(batchDate: string, ruleVersion: number): Promise<string> {
    const { rows } = await this.pool.query(
      `insert into daily_runs (batch_date, rule_version, phase, status) values ($1, $2, 'scoring', 'running') returning id`,
      [batchDate, ruleVersion],
    );
    return String(rows[0]!.id);
  }

  async updateRun(id: string, patch: Partial<Pick<RunRecord, 'phase' | 'status' | 'stats' | 'error' | 'finishedAt'>>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (col: string, v: unknown) => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.phase !== undefined) add('phase', patch.phase);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.stats !== undefined) add('stats', JSON.stringify(patch.stats));
    if (patch.error !== undefined) add('error', patch.error);
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt);
    if (sets.length === 0) return;
    values.push(id);
    await this.pool.query(`update daily_runs set ${sets.join(', ')} where id = $${values.length}`, values);
  }

  async getLatestRun(date: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query(
      `select * from daily_runs where batch_date = $1 order by started_at desc limit 1`,
      [date],
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      id: String(r.id),
      batchDate: r.batch_date,
      ruleVersion: Number(r.rule_version),
      phase: String(r.phase),
      status: String(r.status),
      stats: r.stats ?? null,
      error: r.error ?? null,
      startedAt: new Date(r.started_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
  }

  // —— 打分 / 理由 / 决策 ——
  async saveScoreRecords(rows: ScoreRecordRow[]): Promise<void> {
    for (const r of rows) {
      await this.pool.query(
        `insert into score_records
           (run_id, product_id, rule_version, gate_passed, gate_results, dimension_scores, total, complete, grade, flags)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (run_id, product_id) do update set
           gate_passed = excluded.gate_passed, gate_results = excluded.gate_results,
           dimension_scores = excluded.dimension_scores, total = excluded.total,
           complete = excluded.complete, grade = excluded.grade, flags = excluded.flags`,
        [
          r.runId, r.productId, r.ruleVersion, r.gatePassed,
          JSON.stringify(r.gateResults), JSON.stringify(r.dimensionScores),
          r.total, r.complete, r.grade, JSON.stringify(r.flags),
        ],
      );
    }
  }

  async saveReasons(rows: ReasonRow[]): Promise<void> {
    for (const r of rows) {
      await this.pool.query(
        `insert into reasons (run_id, product_id, text, cited_fields, source)
         values ($1,$2,$3,$4,$5)
         on conflict (run_id, product_id) do update set
           text = excluded.text, cited_fields = excluded.cited_fields, source = excluded.source`,
        [r.runId, r.productId, r.text, JSON.stringify(r.citedFields), r.source],
      );
    }
  }

  async saveDecisions(rows: DecisionRow[]): Promise<void> {
    for (const r of rows) {
      // append-only + 幂等：冲突即忽略（重复勾选不产生新行）
      await this.pool.query(
        `insert into decisions (run_id, batch_date, product_id, action, decided_by, note, rule_version_at_decision, total_score)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (run_id, product_id, action) do nothing`,
        [r.runId, r.batchDate, r.productId, r.action, r.decidedBy, r.note ?? null, r.ruleVersion ?? null, r.totalScore ?? null],
      );
    }
  }

  async getDailyList(date: string): Promise<DailyList | null> {
    const run = await this.getLatestRun(date);
    if (!run) return null;
    const { rows } = await this.pool.query(
      `select p.external_id, ps.title, ps.category, ps.price, ps.commission_rate, ps.sales_30d, ps.mom_trend, ps.review_rate,
              sc.product_id, sc.total, sc.grade, sc.gate_passed, sc.complete, sc.flags,
              re.text as reason, re.source as reason_source,
              (d.id is not null) as selected
       from daily_runs r
       join score_records sc on sc.run_id = r.id
       join products p on p.id = sc.product_id
       join product_snapshots ps on ps.product_id = sc.product_id and ps.batch_date = r.batch_date
       left join reasons re on re.run_id = r.id and re.product_id = sc.product_id
       left join decisions d on d.run_id = r.id and d.product_id = sc.product_id and d.action = 'selected'
       where r.id = $1
       order by sc.total desc, p.external_id asc`,
      [run.id],
    );
    const items: DailyListItem[] = rows.map((r) => ({
      productId: String(r.product_id),
      externalId: String(r.external_id),
      title: r.title ?? '',
      category: r.category ?? null,
      price: num(r.price),
      commissionRate: num(r.commission_rate),
      sales30d: r.sales_30d == null ? null : Number(r.sales_30d),
      momTrend: (r.mom_trend ?? null) as DailyListItem['momTrend'],
      reviewRate: num(r.review_rate),
      total: Number(r.total),
      grade: (r.grade ?? null) as DailyListItem['grade'],
      gatePassed: Boolean(r.gate_passed),
      complete: Boolean(r.complete),
      flags: Array.isArray(r.flags) ? (r.flags as string[]) : [],
      reason: r.reason ?? null,
      reasonSource: (r.reason_source ?? null) as DailyListItem['reasonSource'],
      selected: Boolean(r.selected),
    }));
    return { date, runId: run.id, ruleVersion: run.ruleVersion, phase: run.phase, status: run.status, items };
  }

  async findSimilarProducts(categories: string[], limit: number): Promise<SimilarProduct[]> {
    if (categories.length === 0) return [];
    const { rows } = await this.pool.query(
      `select p.external_id, p.title, ps.category, sc.total, d.action, d.batch_date
       from decisions d
       join products p on p.id = d.product_id
       join product_snapshots ps on ps.product_id = d.product_id and ps.batch_date = d.batch_date
       join score_records sc on sc.run_id = d.run_id and sc.product_id = d.product_id
       where ps.category = any($1)
       order by d.decided_at desc
       limit $2`,
      [categories, limit],
    );
    return rows.map((r) => ({
      externalId: String(r.external_id),
      title: r.title ?? '',
      category: r.category ?? null,
      total: Number(r.total),
      action: String(r.action),
      batchDate: r.batch_date,
    }));
  }

  // —— 内容草稿（模块② B1）——
  private mapDraftRow(r: any): ContentDraftRow {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      batchDate: String(r.batch_date),
      productId: String(r.product_id),
      platform: String(r.platform) as Platform,
      status: String(r.status) as ContentDraftRow['status'],
      content: (r.content ?? null) as ContentDraftRow['content'],
      bannedHits: Array.isArray(r.banned_hits) ? (r.banned_hits as string[]) : [],
      review: (r.review ?? null) as ContentDraftRow['review'],
      duplicates: Array.isArray(r.duplicates) ? (r.duplicates as DuplicateHit[]) : [],
      revisionCount: r.revision_count == null ? 0 : Number(r.revision_count),
      note: (r.note ?? null) as string | null,
      source: String(r.source) as ContentDraftRow['source'],
      createdAt: new Date(r.created_at).toISOString(),
      externalId: String(r.external_id),
      title: (r.title ?? '') as string,
    };
  }

  async saveContentDrafts(rows: ContentDraftInput[]): Promise<void> {
    for (const r of rows) {
      await this.pool.query(
        `insert into content_drafts (run_id, batch_date, product_id, platform, status, content, banned_hits, review, duplicates, revision_count, note, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (product_id, platform) do update set
           run_id = excluded.run_id, batch_date = excluded.batch_date, status = excluded.status,
           content = excluded.content, banned_hits = excluded.banned_hits, review = excluded.review,
           duplicates = excluded.duplicates, revision_count = excluded.revision_count,
           note = excluded.note, source = excluded.source, created_at = now()`,
        [
          r.runId, r.batchDate, r.productId, r.platform, r.status,
          r.content === null ? null : JSON.stringify(r.content),
          JSON.stringify(r.bannedHits),
          r.review === null ? null : JSON.stringify(r.review),
          JSON.stringify(r.duplicates),
          r.revisionCount,
          r.note, r.source,
        ],
      );
    }
  }

  async getContentDrafts(date: string): Promise<ContentDraftRow[]> {
    const { rows } = await this.pool.query(
      `select cd.id, cd.run_id, cd.batch_date, cd.product_id, cd.platform, cd.status, cd.content, cd.banned_hits,
              cd.review, cd.duplicates, cd.revision_count, cd.note, cd.source, cd.created_at,
              p.external_id, p.title
       from content_drafts cd join products p on p.id = cd.product_id
       where cd.batch_date = $1
       order by p.external_id asc, cd.platform asc`,
      [date],
    );
    return rows.map((r) => this.mapDraftRow(r));
  }

  async getRecentContentDrafts(since: string, before: string): Promise<ContentDraftRow[]> {
    const { rows } = await this.pool.query(
      `select cd.id, cd.run_id, cd.batch_date, cd.product_id, cd.platform, cd.status, cd.content, cd.banned_hits,
              cd.review, cd.duplicates, cd.revision_count, cd.note, cd.source, cd.created_at,
              p.external_id, p.title
       from content_drafts cd join products p on p.id = cd.product_id
       where cd.batch_date >= $1::date and cd.batch_date < $2::date
         and cd.status in ('draft','confirmed') and cd.content is not null
       order by cd.batch_date desc, p.external_id asc
       limit 200`,
      [since, before],
    );
    return rows.map((r) => this.mapDraftRow(r));
  }

  async applyContentDecision(decision: ContentDecisionInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // 状态推进 + 决策落库同事务：中途失败整体回滚，杜绝「状态已变但无决策」的审计断链
      const { rowCount } = await client.query(
        `update content_drafts set status = $2 where id = $1`,
        [decision.draftId, decision.action],
      );
      if (rowCount === 0) throw new Error(`内容草稿不存在: ${decision.draftId}`);
      await client.query(
        `insert into content_decisions (draft_id, run_id, batch_date, product_id, platform, action, checklist, note, decided_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          decision.draftId, decision.runId, decision.batchDate, decision.productId, decision.platform, decision.action,
          decision.checklist === null ? null : JSON.stringify(decision.checklist),
          decision.note, decision.decidedBy,
        ],
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async saveContentDecisions(rows: ContentDecisionInput[]): Promise<void> {
    for (const r of rows) {
      await this.pool.query(
        `insert into content_decisions (draft_id, run_id, batch_date, product_id, platform, action, checklist, note, decided_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          r.draftId, r.runId, r.batchDate, r.productId, r.platform, r.action,
          r.checklist === null ? null : JSON.stringify(r.checklist),
          r.note, r.decidedBy,
        ],
      );
    }
  }

  async getContentDecisions(date: string): Promise<ContentDecisionRow[]> {
    const { rows } = await this.pool.query(
      `select cd.draft_id, cd.run_id, cd.batch_date, cd.product_id, cd.platform, cd.action, cd.checklist, cd.note, cd.decided_by, cd.decided_at
       from content_decisions cd
       where cd.batch_date = $1
       order by cd.decided_at asc`,
      [date],
    );
    return rows.map((r) => ({
      draftId: String(r.draft_id),
      runId: String(r.run_id),
      batchDate: String(r.batch_date),
      productId: String(r.product_id),
      platform: String(r.platform) as Platform,
      action: String(r.action) as ContentDecisionRow['action'],
      checklist: (r.checklist ?? null) as ContentDecisionRow['checklist'],
      note: (r.note ?? null) as string | null,
      decidedBy: String(r.decided_by),
      decidedAt: new Date(r.decided_at).toISOString(),
    }));
  }

  // —— 发布台账（模块③ B2）——
  private mapPublishRow(r: any): PublishRecordRow {
    return {
      id: String(r.id),
      draftId: String(r.draft_id),
      runId: String(r.run_id),
      batchDate: String(r.batch_date),
      productId: String(r.product_id),
      platform: String(r.platform) as Platform,
      status: String(r.status) as PublishRecordRow['status'],
      plannedAt: r.planned_at == null ? null : new Date(r.planned_at).toISOString(),
      publishedAt: r.published_at == null ? null : new Date(r.published_at).toISOString(),
      url: (r.url ?? null) as string | null,
      aiLabeled: r.ai_labeled == null ? null : Boolean(r.ai_labeled),
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async createPublishRecord(rec: PublishRecordInput): Promise<PublishRecordRow> {
    const { rows } = await this.pool.query(
      `insert into publish_records (draft_id, run_id, batch_date, product_id, platform, status, planned_at)
       values ($1,$2,$3,$4,$5,'pending',$6)
       returning id, draft_id, run_id, batch_date, product_id, platform, status, planned_at, published_at, url, ai_labeled, created_at`,
      [rec.draftId, rec.runId, rec.batchDate, rec.productId, rec.platform, rec.plannedAt],
    );
    return this.mapPublishRow(rows[0]!); // 同 draft_id 重复插入由 unique 约束抛错（调用方先查重）
  }

  async getPublishRecords(date: string): Promise<PublishRecordRow[]> {
    const { rows } = await this.pool.query(
      `select id, draft_id, run_id, batch_date, product_id, platform, status, planned_at, published_at, url, ai_labeled, created_at
       from publish_records
       where batch_date = $1
       order by created_at asc, id asc`,
      [date],
    );
    return rows.map((r) => this.mapPublishRow(r));
  }

  async recordPublish(id: string, patch: { url: string; publishedAt: string; aiLabeled: boolean }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(`select status from publish_records where id = $1 for update`, [id]);
      if (rows.length === 0) throw new Error(`发布记录不存在: ${id}`);
      if (String(rows[0]!.status) !== 'pending') throw new Error(`发布记录已回填过（幂等拒绝）: ${id}`);
      await client.query(
        `update publish_records set status = 'published', published_at = $2, url = $3, ai_labeled = $4, updated_at = now()
         where id = $1`,
        [id, patch.publishedAt, patch.url, patch.aiLabeled],
      );
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  // —— 深度调研摘要（模块① V2）——
  private mapResearchRow(r: Record<string, unknown>): ResearchRow {
    const s = r.summary as { sentiment: ResearchSummary['sentiment']; highlights: string[]; risks: string[]; material_points: string[] };
    return {
      id: String(r.id),
      productId: String(r.product_id),
      sourceText: String(r.source_text ?? ''),
      summary: {
        sentiment: s.sentiment,
        highlights: Array.isArray(s.highlights) ? s.highlights : [],
        risks: Array.isArray(s.risks) ? s.risks : [],
        materialPoints: Array.isArray(s.material_points) ? s.material_points : [],
      },
      runId: r.run_id == null ? null : String(r.run_id),
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async getResearch(productId: string): Promise<ResearchRow | null> {
    const { rows } = await this.pool.query(
      `select * from product_research where product_id = $1`,
      [productId],
    );
    return rows.length === 0 ? null : this.mapResearchRow(rows[0]!);
  }

  async saveResearch(rec: ResearchInput): Promise<void> {
    await this.pool.query(
      `insert into product_research (product_id, source_text, summary, run_id)
       values ($1, $2, $3::jsonb, $4)
       on conflict (product_id) do update set
         source_text = excluded.source_text, summary = excluded.summary,
         run_id = excluded.run_id, updated_at = now()`,
      [
        rec.productId,
        rec.sourceText,
        JSON.stringify({
          sentiment: rec.summary.sentiment,
          highlights: rec.summary.highlights,
          risks: rec.summary.risks,
          material_points: rec.summary.materialPoints,
        }),
        rec.runId,
      ],
    );
  }

  // —— 表现台账（模块④ B3 第一批 + P0 真实数据 manual）——
  private mapSimRow(r: Record<string, unknown>): SimContentStatRow {
    return {
      source: r.source === 'manual' ? 'manual' : 'kuairec',
      videoId: String(r.video_id),
      authorId: String(r.author_id),
      statDate: String(r.stat_date),
      videoType: r.video_type == null ? null : String(r.video_type),
      uploadDt: r.upload_dt == null ? null : String(r.upload_dt),
      videoDuration: num(r.video_duration),
      videoTagName: r.video_tag_name == null ? null : String(r.video_tag_name),
      showCnt: Number(r.show_cnt ?? 0),
      playCnt: Number(r.play_cnt ?? 0),
      completePlayCnt: Number(r.complete_play_cnt ?? 0),
      likeCnt: Number(r.like_cnt ?? 0),
      commentCnt: Number(r.comment_cnt ?? 0),
      shareCnt: Number(r.share_cnt ?? 0),
      followCnt: Number(r.follow_cnt ?? 0),
      collectCnt: Number(r.collect_cnt ?? 0),
      reportCnt: Number(r.report_cnt ?? 0),
      caption: r.caption == null ? null : String(r.caption),
      topicTag: r.topic_tag == null ? null : String(r.topic_tag),
      category: r.category == null ? null : String(r.category),
    };
  }

  async upsertSimStats(rows: SimContentStatRow[]): Promise<{ inserted: number; skipped: number }> {
    // 20 列/行；每批 1000 行 = 2 万参数（pg 上限 65535，留足余量）
    const COLS = 20;
    const BATCH = 1000;
    let inserted = 0;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const values: unknown[] = [];
        const tuples = batch
          .map((r, i) => {
            const base = i * COLS;
            const cols = [
              r.source, r.videoId, r.authorId, r.statDate, r.videoType, r.uploadDt, r.videoDuration,
              r.videoTagName, r.showCnt, r.playCnt, r.completePlayCnt, r.likeCnt, r.commentCnt,
              r.shareCnt, r.followCnt, r.collectCnt, r.reportCnt, r.caption, r.topicTag, r.category,
            ];
            values.push(...cols);
            return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
          })
          .join(',');
        const { rowCount } = await client.query(
          `insert into sim_content_stats
             (source, video_id, author_id, stat_date, video_type, upload_dt, video_duration, video_tag_name,
              show_cnt, play_cnt, complete_play_cnt, like_cnt, comment_cnt, share_cnt, follow_cnt,
              collect_cnt, report_cnt, caption, topic_tag, category)
           values ${tuples}
           on conflict (source, video_id, stat_date) do nothing`, // 幂等：已存在跳过，不覆盖
          values,
        );
        inserted += rowCount ?? 0;
      }
      await client.query('commit');
      return { inserted, skipped: rows.length - inserted };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async getSimStatsByAuthor(source: SimSource, authorId: string): Promise<SimContentStatRow[]> {
    const { rows } = await this.pool.query(
      `select * from sim_content_stats where source = $1 and author_id = $2 order by stat_date asc, video_id asc`,
      [source, authorId],
    );
    return rows.map((r) => this.mapSimRow(r));
  }

  async listSimAuthors(source: SimSource, limit: number): Promise<SimAuthorOverview[]> {
    const { rows } = await this.pool.query(
      `select author_id,
              count(distinct video_id) as video_count,
              min(stat_date)::text as date_from,
              max(stat_date)::text as date_to,
              sum(show_cnt) as total_show,
              sum(play_cnt) as total_play,
              sum(follow_cnt) as total_follow
       from sim_content_stats
       where source = $1
       group by author_id
       order by total_show desc
       limit $2`,
      [source, limit],
    );
    return rows.map((r) => ({
      authorId: String(r.author_id),
      videoCount: Number(r.video_count),
      dateFrom: String(r.date_from),
      dateTo: String(r.date_to),
      totalShow: Number(r.total_show ?? 0),
      totalPlay: Number(r.total_play ?? 0),
      totalFollow: Number(r.total_follow ?? 0),
    }));
  }

  // —— 商品层表现（模块④ V3：真实通道，source 类型锁死 'manual'）——
  async upsertProductStats(rows: ProductPerfRow[]): Promise<{ inserted: number; skipped: number }> {
    // 10 列/行；每批 1000 行 = 1 万参数（pg 上限 65535，留足余量）
    const COLS = 10;
    const BATCH = 1000;
    let inserted = 0;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const values: unknown[] = [];
        const tuples = batch
          .map((r, i) => {
            const base = i * COLS;
            const cols = [
              r.source, r.productId, r.statDate, r.productTitle, r.category,
              r.clickCnt, r.addCartCnt, r.orderCnt, r.gmvAmount, r.commissionAmount,
            ];
            values.push(...cols);
            return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
          })
          .join(',');
        const { rowCount } = await client.query(
          `insert into product_performance
             (source, product_id, stat_date, product_title, category,
              click_cnt, add_cart_cnt, order_cnt, gmv_amount, commission_amount)
           values ${tuples}
           on conflict (source, product_id, stat_date) do nothing`, // 幂等：已存在跳过，不覆盖
          values,
        );
        inserted += rowCount ?? 0;
      }
      await client.query('commit');
      return { inserted, skipped: rows.length - inserted };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async listProductPerformance(source: ProductPerfSource, limit: number): Promise<ProductPerfSummary[]> {
    // 标题/类目取数据日内最新非空值：null 排最后，再按日期倒序取第一个
    const { rows } = await this.pool.query(
      `select product_id,
              (array_agg(product_title order by (product_title is null), stat_date desc))[1] as product_title,
              (array_agg(category order by (category is null), stat_date desc))[1] as category,
              min(stat_date)::text as date_from,
              max(stat_date)::text as date_to,
              count(*) as stat_days,
              sum(click_cnt) as click_cnt,
              sum(add_cart_cnt) as add_cart_cnt,
              sum(order_cnt) as order_cnt,
              sum(gmv_amount) as gmv_amount,
              sum(commission_amount) as commission_amount
       from product_performance
       where source = $1
       group by product_id
       order by gmv_amount desc, product_id asc
       limit $2`,
      [source, limit],
    );
    return rows.map((r) => ({
      productId: String(r.product_id),
      productTitle: r.product_title == null ? null : String(r.product_title),
      category: r.category == null ? null : String(r.category),
      dateFrom: String(r.date_from),
      dateTo: String(r.date_to),
      statDays: Number(r.stat_days),
      clickCnt: Number(r.click_cnt ?? 0),
      addCartCnt: Number(r.add_cart_cnt ?? 0),
      orderCnt: Number(r.order_cnt ?? 0),
      gmvAmount: Math.round(Number(r.gmv_amount ?? 0) * 100) / 100,
      commissionAmount: Math.round(Number(r.commission_amount ?? 0) * 100) / 100,
    }));
  }

  async getProductStats(source: ProductPerfSource, productId: string): Promise<ProductPerfRow[]> {
    const { rows } = await this.pool.query(
      `select * from product_performance where source = $1 and product_id = $2 order by stat_date asc`,
      [source, productId],
    );
    return rows.map((r) => ({
      source: 'manual',
      productId: String(r.product_id),
      statDate: String(r.stat_date),
      productTitle: r.product_title == null ? null : String(r.product_title),
      category: r.category == null ? null : String(r.category),
      clickCnt: Number(r.click_cnt),
      addCartCnt: Number(r.add_cart_cnt),
      orderCnt: Number(r.order_cnt),
      gmvAmount: Number(r.gmv_amount),
      commissionAmount: Number(r.commission_amount),
    }));
  }

  // —— 品类趋势背景板（模块① V3：人工导出，source 锁死 manual）——
  async upsertCategoryTrends(rows: CategoryTrendRow[]): Promise<{ inserted: number; skipped: number }> {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };
    // 幂等：(source, category, stat_date) 冲突跳过不覆盖（与 MemoryRepo 语义一致）
    const { rowCount } = await this.pool.query(
      `insert into category_trend (source, category, stat_date, search_index)
       select * from unnest($1::text[], $2::text[], $3::date[], $4::bigint[])
       on conflict (source, category, stat_date) do nothing`,
      [rows.map((r) => r.source), rows.map((r) => r.category), rows.map((r) => r.statDate), rows.map((r) => r.searchIndex)],
    );
    return { inserted: rowCount ?? 0, skipped: rows.length - (rowCount ?? 0) };
  }

  async listCategoryTrends(source: CategoryTrendSource, limit: number): Promise<CategoryTrendSummary[]> {
    // 按品类聚合：最新/前一日指数 + 日环比 + 区间涨跌幅（除数为 0 → null，不猜）
    const { rows } = await this.pool.query(
      `select category,
              min(stat_date)::text as date_from,
              max(stat_date)::text as date_to,
              count(*)::int as stat_days,
              (array_agg(search_index order by stat_date desc))[1] as latest_index,
              (array_agg(search_index order by stat_date desc))[2] as prev_index,
              (array_agg(search_index order by stat_date asc))[1] as first_index
       from category_trend where source = $1 group by category`,
      [source],
    );
    const summaries: CategoryTrendSummary[] = rows.map((r) => {
      const latestIndex = Number(r.latest_index);
      const prevIndex = r.prev_index == null ? null : Number(r.prev_index);
      const firstIndex = Number(r.first_index);
      return {
        category: String(r.category),
        dateFrom: String(r.date_from),
        dateTo: String(r.date_to),
        statDays: Number(r.stat_days),
        latestIndex,
        prevIndex,
        dayOverDayPct: prevIndex == null || prevIndex === 0 ? null : ((latestIndex - prevIndex) / prevIndex) * 100,
        rangePct: firstIndex === 0 ? null : ((latestIndex - firstIndex) / firstIndex) * 100,
      };
    });
    return summaries
      .sort((a, b) => {
        const av = a.dayOverDayPct ?? -Infinity;
        const bv = b.dayOverDayPct ?? -Infinity;
        return bv - av || a.category.localeCompare(b.category);
      })
      .slice(0, limit);
  }

  async getCategoryTrend(source: CategoryTrendSource, category: string): Promise<CategoryTrendRow[]> {
    const { rows } = await this.pool.query(
      `select * from category_trend where source = $1 and category = $2 order by stat_date asc`,
      [source, category],
    );
    return rows.map((r) => ({
      source: 'manual',
      category: String(r.category),
      statDate: String(r.stat_date),
      searchIndex: Number(r.search_index),
    }));
  }

  // —— 模拟播放事件（模块④ B3 第二批）——
  private mapSimPlayRow(r: Record<string, unknown>): SimPlayEventRow {
    return {
      source: 'kuairec',
      videoId: String(r.video_id),
      userId: String(r.user_id),
      watchDate: r.watch_date == null ? null : String(r.watch_date),
      watchTs: Number(r.watch_ts),
      watchedAt: r.watched_at == null ? null : String(r.watched_at),
      playDuration: num(r.play_duration),
      videoDuration: num(r.video_duration),
      watchRatio: num(r.watch_ratio),
    };
  }

  async upsertSimPlayEvents(rows: SimPlayEventRow[]): Promise<{ inserted: number; skipped: number }> {
    // 9 列/行；每批 5000 行 = 4.5 万参数（pg 上限 65535）——467 万行按 5000/批约 934 批
    const COLS = 9;
    const BATCH = 5000;
    let inserted = 0;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const values: unknown[] = [];
        const tuples = batch
          .map((r, i) => {
            const base = i * COLS;
            const cols = [
              r.source, r.videoId, r.userId, r.watchDate, r.watchTs,
              r.watchedAt, r.playDuration, r.videoDuration, r.watchRatio,
            ];
            values.push(...cols);
            return `(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`;
          })
          .join(',');
        const { rowCount } = await client.query(
          `insert into sim_play_events
             (source, video_id, user_id, watch_date, watch_ts, watched_at, play_duration, video_duration, watch_ratio)
           values ${tuples}
           on conflict (source, video_id, user_id, watch_ts) do nothing`, // 幂等：已存在跳过，不覆盖
          values,
        );
        inserted += rowCount ?? 0;
      }
      await client.query('commit');
      return { inserted, skipped: rows.length - inserted };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }

  async getSimPlayEventsByVideo(videoId: string): Promise<SimPlayEventRow[]> {
    const { rows } = await this.pool.query(
      `select * from sim_play_events where video_id = $1 order by watch_ts asc`,
      [videoId],
    );
    return rows.map((r) => this.mapSimPlayRow(r));
  }

  async getSimStatsByVideo(source: SimSource, videoId: string): Promise<SimContentStatRow[]> {
    const { rows } = await this.pool.query(
      `select * from sim_content_stats where source = $1 and video_id = $2 order by stat_date asc`,
      [source, videoId],
    );
    return rows.map((r) => this.mapSimRow(r));
  }

  // —— LLM 审计 ——
  /** 勾选门 24h 超时：指定日期之前的 submitted 清单 → expired（顺延不阻塞） */
  async expireStaleSubmittedRuns(beforeDate: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `update daily_runs set phase = 'expired', finished_at = now()
       where phase = 'submitted' and batch_date < $1::date`,
      [beforeDate],
    );
    return rowCount ?? 0;
  }

  async countLlmCallsToday(): Promise<number> {
    const { rows } = await this.pool.query(
      `select count(*) as c from llm_call_logs where created_at >= date_trunc('day', now())`,
    );
    return Number(rows[0]!.c);
  }

  async saveLlmLog(entry: LlmLogEntry): Promise<void> {
    await this.pool.query(
      `insert into llm_call_logs (run_id, purpose, model, skill, input, output, ok, error, latency_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.runId ?? null, entry.purpose, entry.model ?? null, entry.skill ?? null,
        JSON.stringify(entry.input), entry.output === undefined ? null : JSON.stringify(entry.output),
        entry.ok, entry.error ?? null, entry.latencyMs ?? null,
      ],
    );
  }
}
