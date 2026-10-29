'use client';

/**
 * 勾选门（门①）最小页面：
 * - 拉取后端 /api/daily-list（Fastify，默认 http://localhost:8787）
 * - 勾选候选品 → POST /api/select（append-only 决策流水）
 * - 只读展示：门槛淘汰 / 待评品不做勾选（人可以推翻规则，但走 CLI 留更完整审计）
 */
import { useCallback, useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

interface Item {
  productId: string;
  externalId: string;
  title: string;
  category: string | null;
  price: number | null;
  commissionRate: number | null;
  sales30d: number | null;
  momTrend: string | null;
  reviewRate: number | null;
  total: number;
  grade: 'strong' | 'test' | 'drop' | null;
  gatePassed: boolean;
  complete: boolean;
  flags: string[];
  reason: string | null;
  reasonSource: 'llm' | 'template' | 'manual' | null;
  selected: boolean;
}

interface DailyList {
  date: string;
  runId: string;
  ruleVersion: number;
  phase: string;
  status: string;
  items: Item[];
}

const GRADE_LABEL: Record<string, string> = { strong: '强推', test: '可测', drop: '放弃' };
const SRC_LABEL: Record<string, string> = { llm: 'AI 理由', template: '模板理由', manual: '人工' };

function trendLabel(t: string | null): string {
  if (t === 'up') return ' ↗';
  if (t === 'down') return ' ↘';
  return '';
}

export default function Page() {
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [list, setList] = useState<DailyList | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/daily-list?date=${d}`);
      const body = await res.json();
      if (!res.ok) {
        setList(null);
        setError(body?.error ?? `请求失败（${res.status}）`);
        return;
      }
      setList(body as DailyList);
      setChecked(new Set(((body as DailyList).items ?? []).filter((i) => i.selected).map((i) => i.externalId)));
    } catch (e) {
      setList(null);
      setError(`连不上后端（${API}）：${e instanceof Error ? e.message : String(e)}。先启动 API：npm run api`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const ranked = (list?.items ?? []).filter((i) => i.gatePassed && i.complete);
  const others = (list?.items ?? []).filter((i) => !(i.gatePassed && i.complete));

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!list) return;
    const ids = [...checked];
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date, externalIds: ids, note: 'web 勾选门' }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `提交失败（${res.status}）`);
        return;
      }
      setNotice(`已勾选 ${body.selected?.length ?? 0} 个（幂等跳过 ${body.alreadySelected?.length ?? 0} 个），决策已 append-only 落库。`);
      await load(date);
    } catch (e) {
      setError(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="wrap">
      <header className="top">
        <h1>AI 带货工作台</h1>
        <span className="sub">今日候选清单 · 人只做勾选（门①）</span>
      </header>

      <div className="toolbar">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={() => void load(date)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
        <button
          className="primary"
          onClick={() => void submit()}
          disabled={submitting || !list || list.phase === 'selected' || checked.size === 0}
        >
          {submitting ? '提交中…' : `确认勾选（${checked.size}）`}
        </button>
        {list && (
          <span className="sub">
            run {list.runId.slice(0, 8)}… · 规则 v{list.ruleVersion} · {list.phase}
            {list.status === 'degraded' ? ' · LLM 降级' : ''}
          </span>
        )}
      </div>

      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      {!list && !loading && (
        <div className="empty">
          <p>这一天没有候选清单。</p>
          <p>
            先跑流水线：<code>npm run gwd -- daily-scan</code>
          </p>
        </div>
      )}

      {list && (
        <>
          <section>
            <h2>排行榜（门槛通过 + 主观三维齐全，Top{ranked.length}）</h2>
            {ranked.map((i) => (
              <label key={i.productId} className={`card${checked.has(i.externalId) ? ' picked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked.has(i.externalId)}
                  onChange={() => toggle(i.externalId)}
                  disabled={list.phase === 'selected'}
                />
                <div>
                  <div className="title">
                    {i.grade && <span className={`badge ${i.grade}`}>{GRADE_LABEL[i.grade]}</span>}
                    {i.title}
                  </div>
                  <div className="meta">
                    {i.externalId} · {i.category ?? '类目缺失'} · ￥{i.price ?? '-'} · 佣金 {i.commissionRate ?? '-'}% · 销量{' '}
                    {i.sales30d ?? '-'}
                    {trendLabel(i.momTrend)} · 好评 {i.reviewRate ?? '-'}%
                  </div>
                  {i.reason && (
                    <div className="reason">
                      {i.reasonSource && <span className="badge src">{SRC_LABEL[i.reasonSource] ?? i.reasonSource}</span>}
                      {i.reason}
                    </div>
                  )}
                  {i.flags.length > 0 && <div className="flags">⚠ {i.flags.join('；')}</div>}
                </div>
                <div className="score">
                  {i.total}
                  <small>总分</small>
                </div>
              </label>
            ))}
          </section>

          {others.length > 0 && (
            <section>
              <h2>未入榜（门槛未过 / 待评）</h2>
              {others.map((i) => (
                <div key={i.productId} className="card off">
                  <div>
                    <div className="title">
                      {i.grade ? <span className={`badge ${i.grade}`}>{GRADE_LABEL[i.grade]}</span> : null}
                      {i.title}
                    </div>
                    <div className="meta">
                      {i.externalId} · {i.category ?? '类目缺失'} · 佣金 {i.commissionRate ?? '-'}% · 好评 {i.reviewRate ?? '-'}%
                    </div>
                    <div className="flags">{i.flags.length > 0 ? i.flags.join('；') : '门槛未过（一票否决）'}</div>
                  </div>
                  <div className="score">
                    {i.total}
                    <small>不参与排序</small>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <footer>勾选决策 append-only 落库，成为后续内容生成 run 的输入 · 本页面不做发布，发布保持人工</footer>
    </main>
  );
}
