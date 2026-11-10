'use client';

/**
 * 首页总览（模块② P1）：一眼看到今天卡在哪一步。
 * - 只读汇总，复用三个现有 API 的计数（daily-list / contents / publish），不新增后端
 * - 五个流程步骤状态：候选清单 → 勾选 → 内容 → 发布 → 归因
 * - 每个计数卡片可点击直达对应页面；所有文本 React 转义，无注入面
 */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import DateQuick from './components/DateQuick';
import { usePersistentState } from './lib/usePersistentState';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN;

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { 'x-api-token': API_TOKEN } : {};
}

interface DailyList {
  date: string;
  phase: string;
  status: string;
  items: Array<{ gatePassed: boolean; complete: boolean; selected: boolean }>;
}

interface ContentsResult {
  drafts: Array<{ status: string }>;
}

interface PublishResult {
  items: Array<{ record: { status: string } }>;
}

interface Overview {
  date: string;
  candidateTotal: number;
  rankedTotal: number;
  selectedTotal: number;
  pendingDraft: number;
  pendingPublish: number;
  published: number;
  hasList: boolean;
}

const EMPTY: Overview = {
  date: '',
  candidateTotal: 0,
  rankedTotal: 0,
  selectedTotal: 0,
  pendingDraft: 0,
  pendingPublish: 0,
  published: 0,
  hasList: false,
};

export default function OverviewPage() {
  const [date, setDate] = usePersistentState<string>('gwd:overview:date', new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      // 三路并行拉取，各自容错：单个失败不影响其他（总览页要尽量给信息）
      const [listRes, contentsRes, publishRes] = await Promise.all([
        fetch(`${API}/api/daily-list?date=${d}`, { headers: authHeaders() }),
        fetch(`${API}/api/contents?date=${d}`, { headers: authHeaders() }),
        fetch(`${API}/api/publish?date=${d}`, { headers: authHeaders() }),
      ]);

      const listBody = listRes.ok ? ((await listRes.json()) as DailyList) : null;
      const contentsBody = contentsRes.ok ? ((await contentsRes.json()) as ContentsResult) : null;
      const publishBody = publishRes.ok ? ((await publishRes.json()) as PublishResult) : null;

      const items = listBody?.items ?? [];
      const ranked = items.filter((i) => i.gatePassed && i.complete);
      const selected = items.filter((i) => i.selected);
      const drafts = contentsBody?.drafts ?? [];
      const pendingDraft = drafts.filter((s) => s.status === 'draft' || s.status === 'needs_manual').length;
      const pubItems = publishBody?.items ?? [];
      const pendingPublish = pubItems.filter((i) => i.record.status === 'pending').length;
      const published = pubItems.filter((i) => i.record.status === 'published').length;

      setData({
        date: d,
        candidateTotal: items.length,
        rankedTotal: ranked.length,
        selectedTotal: selected.length,
        pendingDraft,
        pendingPublish,
        published,
        hasList: listBody != null,
      });
    } catch (e) {
      setData(null);
      setError(`连不上后端（${API}）：${e instanceof Error ? e.message : String(e)}。先启动 API：npm run api`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const d = data ?? EMPTY;

  return (
    <main className="wrap wide">
      <header className="top">
        <h1>今日总览</h1>
        <span className="sub">今天卡在哪一步，一眼看清 · 数据只读汇总</span>
      </header>

      <div className="toolbar">
        <DateQuick value={date} onChange={setDate} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={() => void load(date)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
        {data && <span className="sub">{data.date}</span>}
      </div>

      {error && <div className="msg error">{error}</div>}

      {!data && !loading && !error && (
        <div className="empty">
          <p>暂无数据。</p>
          <p>
            先跑流水线：<code>npm run gwd -- daily-scan</code>
          </p>
        </div>
      )}

      {data && !d.hasList && !loading && (
        <div className="empty">
          <p>{d.date} 还没有候选清单。</p>
          <p>
            先跑：<code>npm run gwd -- daily-scan</code>
          </p>
        </div>
      )}

      {data && d.hasList && (
        <>
          <section>
            <h2>今日进度（{d.date}）</h2>
            <div className="overview-grid">
              <Link className="overview-card" href="/gate">
                <b>{d.rankedTotal}</b>
                <span>候选品入榜（待勾选）</span>
                {d.rankedTotal > 0 && d.selectedTotal === 0 && <span className="hint">→ 去勾选</span>}
              </Link>
              <Link className="overview-card" href="/gate">
                <b>{d.selectedTotal}</b>
                <span>已勾选（进入内容生成）</span>
              </Link>
              <Link className="overview-card" href="/contents">
                <b>{d.pendingDraft}</b>
                <span>待确认草稿</span>
                {d.pendingDraft > 0 && <span className="hint">→ 去确认（门③）</span>}
              </Link>
              <Link className="overview-card" href="/publish">
                <b>{d.pendingPublish}</b>
                <span>待发布</span>
                {d.pendingPublish > 0 && <span className="hint">→ 去发布（门④）</span>}
              </Link>
              <Link className="overview-card" href="/attribution">
                <b>{d.published}</b>
                <span>已发布（进归因）</span>
              </Link>
            </div>
          </section>

          <section>
            <h2>流水线状态</h2>
            <FlowSteps d={d} />
          </section>
        </>
      )}

      <footer>首页只读汇总 · 各计数来自 daily-list / contents / publish 三个只读 API · 点击卡片直达对应步骤</footer>
    </main>
  );
}

/** 五步流水线：候选 → 勾选 → 内容 → 发布 → 归因 */
function FlowSteps({ d }: { d: Overview }) {
  const steps: Array<{ label: string; href: string; done: boolean; now: boolean }> = [
    { label: '① 候选清单', href: '/gate', done: d.hasList, now: d.hasList && d.selectedTotal === 0 },
    { label: '② 勾选', href: '/gate', done: d.selectedTotal > 0, now: d.selectedTotal > 0 && d.pendingDraft === 0 },
    { label: '③ 内容确认', href: '/contents', done: d.pendingDraft === 0 && d.selectedTotal > 0, now: d.pendingDraft > 0 },
    { label: '④ 发布', href: '/publish', done: d.pendingPublish === 0 && d.pendingDraft === 0 && d.selectedTotal > 0, now: d.pendingPublish > 0 },
    { label: '⑤ 归因', href: '/attribution', done: d.published > 0, now: d.published > 0 && d.pendingPublish === 0 },
  ];

  return (
    <div>
      {steps.map((s) => (
        <Link key={s.label} href={s.href} className="flow-step" style={{ textDecoration: 'none' }}>
          <span className={`dot ${s.now ? 'now' : s.done ? 'done' : 'todo'}`}>{s.now ? '▶' : s.done ? '✓' : '·'}</span>
          <span className={`label${s.now || s.done ? '' : ' muted'}`}>{s.label}</span>
        </Link>
      ))}
    </div>
  );
}
