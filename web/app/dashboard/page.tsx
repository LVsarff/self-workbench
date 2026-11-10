'use client';

/**
 * 数据看板页（P1 Web 端补全，模块④）：
 * - 双源切换：模拟数据（kuairec）/ 真实数据（manual），后端按 source 强制隔离，永不混读
 * - 声明横幅（红线）：模拟看板必须显眼标注「模拟数据 · 方法已验证、参数未验证」，
 *   真实看板标注「真实数据 · 手工导入、无归因链路」——声明来自后端返回，前端不做二次加工
 * - 图表 = 手写 SVG（零新增依赖）；所有文本经 React 转义渲染，不注入原始 HTML（静态门禁测试兜底）
 */
import { useCallback, useEffect, useState } from 'react';
import { usePersistentState } from '../lib/usePersistentState';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN;

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { 'x-api-token': API_TOKEN } : {};
}

type Source = 'sim' | 'real';

interface DailyPoint {
  date: string;
  showCnt: number;
  playCnt: number;
  completeRate: number;
  interactionRate: number;
  followCnt: number;
}

interface TopContent {
  videoId: string;
  caption: string | null;
  category: string | null;
  uploadDt: string | null;
  showCnt: number;
  playCnt: number;
  completeRate: number;
  likeCnt: number;
}

interface AnomalyDay {
  date: string;
  previousShow: number;
  showCnt: number;
  changePct: number;
  direction: 'up' | 'down';
}

interface DashboardData {
  disclaimer: string;
  authorId: string;
  dateFrom: string;
  dateTo: string;
  videoCount: number;
  totals: {
    showCnt: number;
    playCnt: number;
    completeRate: number;
    interactionRate: number;
    likeCnt: number;
    commentCnt: number;
    shareCnt: number;
    followCnt: number;
  };
  daily: DailyPoint[];
  topContents: TopContent[];
  anomalies: AnomalyDay[];
}

interface DashboardResult {
  dashboard: DashboardData;
  topAuthors: Array<{ authorId: string; totalShow: number; videoCount: number }>;
}

/** 大数转「万」显示；红线：缺失数据显示 '-'，不编造 */
function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '-';
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

function pct(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

/** 手写 SVG 折线图：双序列（曝光 / 播放），零依赖 */
function TrendChart({ daily }: { daily: DailyPoint[] }) {
  const W = 720;
  const H = 220;
  const L = 58;
  const R = 14;
  const T = 14;
  const B = 30;
  const max = Math.max(1, ...daily.map((d) => Math.max(d.showCnt, d.playCnt)));
  const innerW = W - L - R;
  const innerH = H - T - B;
  const x = (i: number) => L + (daily.length > 1 ? (i * innerW) / (daily.length - 1) : innerW / 2);
  const y = (v: number) => T + (1 - v / max) * innerH;
  const line = (pick: (d: DailyPoint) => number) => daily.map((d, i) => `${x(i)},${y(pick(d))}`).join(' ');
  const labelIdx = daily.length <= 1 ? [0] : [0, Math.floor((daily.length - 1) / 2), daily.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="日趋势图：曝光与播放" className="chartsvg">
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line x1={L} x2={W - R} y1={T + g * innerH} y2={T + g * innerH} stroke="var(--line)" strokeWidth="1" />
          <text x={L - 8} y={T + g * innerH + 4} textAnchor="end" className="axis">
            {fmt(max * (1 - g))}
          </text>
        </g>
      ))}
      <polyline points={line((d) => d.showCnt)} fill="none" stroke="var(--brand)" strokeWidth="2" />
      <polyline points={line((d) => d.playCnt)} fill="none" stroke="#3c6ef0" strokeWidth="2" />
      {daily.map((d, i) => (
        <circle key={`s-${d.date}`} cx={x(i)} cy={y(d.showCnt)} r="3" fill="var(--brand)">
          <title>{`${d.date} 曝光 ${fmt(d.showCnt)} · 播放 ${fmt(d.playCnt)} · 完播 ${pct(d.completeRate)} · 涨粉 ${fmt(d.followCnt)}`}</title>
        </circle>
      ))}
      {labelIdx.map((i) => (
        <text key={`x-${i}`} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'} className="axis">
          {daily[i]!.date}
        </text>
      ))}
    </svg>
  );
}

export default function DashboardPage() {
  const [source, setSource] = usePersistentState<Source>('gwd:dashboard:source', 'sim');
  const [author, setAuthor] = usePersistentState<string>('gwd:dashboard:author', '');
  const [data, setData] = useState<DashboardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 首挂载读一次 ?source= / ?author=（post-mount，URL 显式指定优先于 localStorage 记忆）
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get('source');
    if (s === 'sim' || s === 'real') setSource(s);
    const a = q.get('author');
    if (a) setAuthor(a);
  }, []);

  const load = useCallback(async (src: Source, authorId: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = authorId ? `?author=${encodeURIComponent(authorId)}` : '';
      const res = await fetch(`${API}/api/dashboard/${src}${qs}`, { headers: authHeaders() });
      const body = await res.json();
      if (!res.ok) {
        setData(null);
        setError(body?.error ?? `请求失败（${res.status}）`);
        return;
      }
      setData(body as DashboardResult);
    } catch (e) {
      setData(null);
      setError(`连不上后端（${API}）：${e instanceof Error ? e.message : String(e)}。先启动 API：npm run api`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(source, author);
  }, [source, author, load]);

  function switchSource(next: Source) {
    setSource(next);
    setAuthor(''); // 换数据源后账号列表不同，清掉已选账号回到该源默认头部账号
    history.replaceState(null, '', next === 'sim' ? '/dashboard' : `/dashboard?source=${next}`);
  }

  const d = data?.dashboard;
  const isSim = source === 'sim';

  return (
    <main className="wrap wide">
      <header className="top">
        <h1>数据看板</h1>
        <span className="sub">
          账号-内容-日口径 · <a href="/">← 今日总览</a>
        </span>
      </header>

      <div className="toolbar">
        <div className="seg">
          <button className={isSim ? 'on' : ''} onClick={() => switchSource('sim')}>
            模拟数据
          </button>
          <button className={!isSim ? 'on' : ''} onClick={() => switchSource('real')}>
            真实数据
          </button>
        </div>
        {data && data.topAuthors.length > 0 && (
          <select value={author || d?.authorId || ''} onChange={(e) => setAuthor(e.target.value)} aria-label="选择账号">
            {author && !data.topAuthors.some((a) => a.authorId === author) && d && <option value={d.authorId}>{d.authorId}（当前）</option>}
            {data.topAuthors.map((a) => (
              <option key={a.authorId} value={a.authorId}>
                {a.authorId} · 曝光 {fmt(a.totalShow)} · {a.videoCount} 条
              </option>
            ))}
          </select>
        )}
        <button onClick={() => void load(source, author)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && <div className="msg error">{error}</div>}

      {d && (
        <>
          {/* 红线：数据源声明横幅，文案来自后端（模拟/真实各带声明），必须显眼 */}
          <div className={`banner ${isSim ? 'sim' : 'real'}`}>{d.disclaimer}</div>

          <section className="metrics">
            <div className="metric">
              <b>{fmt(d.totals.showCnt)}</b>
              <span>总曝光</span>
            </div>
            <div className="metric">
              <b>{fmt(d.totals.playCnt)}</b>
              <span>总播放</span>
            </div>
            <div className="metric">
              <b>{pct(d.totals.completeRate)}</b>
              <span>完播率</span>
            </div>
            <div className="metric">
              <b>{pct(d.totals.interactionRate)}</b>
              <span>互动率</span>
            </div>
            <div className="metric">
              <b>{fmt(d.totals.followCnt)}</b>
              <span>涨粉</span>
            </div>
            <div className="metric">
              <b>{d.videoCount}</b>
              <span>视频数</span>
            </div>
          </section>
          <p className="range">
            账号 <b>{d.authorId}</b> · 统计区间 {d.dateFrom} ~ {d.dateTo}
          </p>

          <section>
            <h2>
              日趋势（曝光 / 播放）
              <span className="legend">
                <span className="dot show">●</span> 曝光 <span className="dot play">●</span> 播放
              </span>
            </h2>
            <div className="chart">
              {d.daily.length > 0 ? (
                <TrendChart daily={d.daily} />
              ) : (
                <p className="empty-inline">无日趋势数据</p>
              )}
            </div>
          </section>

          <section>
            <h2>Top 内容（按总曝光，前 {d.topContents.length}）</h2>
            {d.topContents.length === 0 && <p className="empty-inline">无内容数据</p>}
            {d.topContents.map((c, i) => (
              <div key={c.videoId} className="card off">
                <div className="rank">{i + 1}</div>
                <div>
                  <div className="title">{c.caption ?? c.videoId}</div>
                  <div className="meta">
                    {c.videoId} · {c.category ?? '类目缺失'} · 发布 {c.uploadDt ?? '-'} · 曝光 {fmt(c.showCnt)} · 播放{' '}
                    {fmt(c.playCnt)} · 完播 {pct(c.completeRate)} · 赞 {fmt(c.likeCnt)}
                  </div>
                </div>
              </div>
            ))}
          </section>

          <section>
            <h2>曝光环比异常日（|变动| ≥ 50%，前日曝光 ≥ 1 万才参与判定）</h2>
            {d.anomalies.length === 0 && <p className="empty-inline">无异常日</p>}
            {d.anomalies.map((a) => (
              <div key={a.date} className={`card anomaly ${a.direction}`}>
                <div>
                  <div className="title">
                    {a.date} {a.direction === 'up' ? '↗ 暴涨' : '↘ 骤降'}
                  </div>
                  <div className="meta">
                    前日 {fmt(a.previousShow)} → 当日 {fmt(a.showCnt)}（{a.changePct > 0 ? '+' : ''}
                    {(a.changePct * 100).toFixed(0)}%）
                  </div>
                </div>
              </div>
            ))}
          </section>

          {data.topAuthors.length > 0 && (
            <section>
              <h2>账号一览（当前源，按总曝光降序）</h2>
              {data.topAuthors.map((a) => (
                <button key={a.authorId} className={`authorrow${a.authorId === d.authorId ? ' cur' : ''}`} onClick={() => setAuthor(a.authorId)}>
                  {a.authorId} · 曝光 {fmt(a.totalShow)} · {a.videoCount} 条
                </button>
              ))}
            </section>
          )}
        </>
      )}

      {!d && !loading && !error && (
        <div className="empty">
          <p>暂无看板数据。</p>
          <p>
            {isSim ? (
              <>
                先导入模拟数据：<code>npm run gwd -- sim-import --limit 30000</code>
              </>
            ) : (
              <>
                先导入真实数据：<code>npm run gwd -- real-import my-stats.csv</code>（模板见 templates/）
              </>
            )}
          </p>
        </div>
      )}

      <footer>看板为只读视图 · 双源按 source 隔离 · 模拟数据永不与真实数据混读</footer>
    </main>
  );
}
