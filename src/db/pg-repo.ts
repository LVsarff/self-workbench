/** PostgreSQL 仓储（node-postgres，参数化 SQL，无 ORM）。 */
import pg from 'pg';
import type { RuleConfig } from '../core/rule-config.js';
import { RuleConfigSchema } from '../core/rule-config.js';
import type { DailyList, DailyListItem, ProductSnapshot, SimilarProduct } from '../core/types.js';
import type {
  DecisionRow,
  LlmLogEntry,
  ReasonRow,
  Repo,
  RunRecord,
  ScoreRecordRow,
  SnapshotWithMeta,
} from './repo.js';

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
