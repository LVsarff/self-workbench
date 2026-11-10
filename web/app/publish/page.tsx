'use client';

/**
 * 发布队列 + 台账页（门④ Web 化，模块③ B2）：
 * - 门③ confirmed → pending 队列（POST /api/publish-sync，幂等可重跑）
 * - 人工发布后回填台账：链接 / 实际时间 / 是否已勾「AI 生成」标注（POST /api/published，一条只回填一次）
 * - 红线：发布动作永远人工，本页零平台对接——只做记录与提醒（建议时段 / 超 24h 警示）
 * - 台账 url 经后端 http(s) 协议白名单校验后才入库，此处方可安全作为链接渲染（React 转义兜底）
 */
import { useCallback, useEffect, useState } from 'react';
import DateQuick from '../components/DateQuick';
import { usePersistentState } from '../lib/usePersistentState';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return API_TOKEN ? { 'x-api-token': API_TOKEN, ...extra } : { ...extra };
}

type Platform = 'xiaohongshu' | 'douyin';

interface PublishRecord {
  id: string;
  runId: string;
  batchDate: string;
  productId: string;
  platform: Platform;
  status: 'pending' | 'published';
  plannedAt: string;
  url: string | null;
  publishedAt: string | null;
  aiLabeled: boolean | null;
  createdAt: string;
}

interface QueueDraft {
  id: string;
  externalId: string;
  title: string;
  platform: Platform;
  status: string;
  content: unknown;
  revisionCount: number;
  source: string;
}

interface QueueItem {
  record: PublishRecord;
  draft: QueueDraft;
  overdue: boolean;
  suggestedSlots: string[];
}

interface PublishResult {
  date: string;
  items: QueueItem[];
}

const PLATFORM_LABEL: Record<Platform, string> = { xiaohongshu: '小红书', douyin: '抖音' };

function fmtTime(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function PublishPage() {
  const [date, setDate] = usePersistentState<string>('gwd:publish:date', new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<PublishResult | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [aiLabeled, setAiLabeled] = useState(false);
  const [publishedAt, setPublishedAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 首挂载读一次 ?date=（与 dashboard / contents 页同惯例）
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const d = q.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
  }, []);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/publish?date=${d}`, { headers: authHeaders() });
      const body = await res.json();
      if (!res.ok) {
        setData(null);
        setError(body?.error ?? `请求失败（${res.status}）`);
        return;
      }
      setData(body as PublishResult);
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

  async function sync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/publish-sync`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ date }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `同步失败（${res.status}）`);
        return;
      }
      setNotice(`队列同步完成：新增 ${body.created} 条，幂等跳过 ${body.skipped} 条（只收门③ 已确认草稿）。`);
      await load(date);
    } catch (e) {
      setError(`同步失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  }

  function openItem(item: QueueItem) {
    const key = item.record.id;
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    setUrl('');
    setAiLabeled(false);
    setPublishedAt('');
    setError(null);
  }

  async function submitRecord(item: QueueItem) {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/published`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          date,
          externalId: item.draft.externalId,
          platform: item.draft.platform,
          url,
          aiLabeled,
          publishedAt: publishedAt || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `提交失败（${res.status}）`);
        return;
      }
      setNotice('台账已回填（一条只回填一次）。这条内容进入 V3 归因的事实表。');
      await load(date);
      setOpenKey(null);
    } catch (e) {
      setError(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const pending = (data?.items ?? []).filter((i) => i.record.status === 'pending');
  const published = (data?.items ?? []).filter((i) => i.record.status === 'published');

  return (
    <main className="wrap wide">
      <header className="top">
        <h1>发布台账</h1>
        <span className="sub">
          门④ · 发布永远人工 · <a href="/">← 今日总览</a>
        </span>
      </header>

      <div className="toolbar">
        <DateQuick value={date} onChange={setDate} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={() => void load(date)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
        <button className="primary" onClick={() => void sync()} disabled={syncing}>
          {syncing ? '同步中…' : '同步待发布队列'}
        </button>
        {data && (
          <span className="sub">
            待发布 {pending.length} · 已发布 {published.length}
          </span>
        )}
      </div>

      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      {data && data.items.length === 0 && !loading && (
        <div className="empty">
          <p>这一天没有发布记录。</p>
          <p>
            流程：<code>npm run gwd -- content-gen</code> → <a href="/contents">门③ 确认</a> → 点上方「同步待发布队列」
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <section>
          <h2>待发布（发布动作人工：复制内容 → 平台发布并勾选「AI 生成」标注 → 回填）</h2>
          {pending.map((item) => {
            const open = openKey === item.record.id;
            return (
              <div key={item.record.id} className={`card${open ? ' picked' : ''} draftcard`}>
                <button className="draftopen" onClick={() => openItem(item)}>
                  <span className={`badge ${item.draft.platform === 'xiaohongshu' ? 'src' : 'strong'}`}>
                    {PLATFORM_LABEL[item.draft.platform]}
                  </span>
                  <span className="title">
                    {item.draft.title} <small className="meta">{item.draft.externalId}</small>
                  </span>
                  {item.overdue && <span className="badge drop">⚠ 入队超 24h 未发布</span>}
                  <span className="meta">{open ? '收起 ▲' : '回填 ▼'}</span>
                </button>
                <div className="meta" style={{ marginTop: 4 }}>
                  建议时段：{item.suggestedSlots.join(' · ')} · 计划 {fmtTime(item.record.plannedAt)} · 入队 {fmtTime(item.record.createdAt)}
                </div>

                {open && (
                  <div className="draftbody">
                    <div className="reviewbox">
                      <b>人工发布步骤</b>
                      <div>1. 去 <a href="/contents">内容确认页</a> 复制这条草稿的正文（或在 CLI 跑 gwd contents 查看）</div>
                      <div>2. 粘贴到{PLATFORM_LABEL[item.draft.platform]}手动发布，记得勾选平台「AI 生成」标注</div>
                      <div>3. 把作品链接填在下面回填台账（一条只回填一次，填错属人工修正场景走 SQL）</div>
                    </div>
                    <input
                      className="noteinput"
                      type="url"
                      placeholder="作品链接（http:// 或 https:// 开头）"
                      value={url}
                      maxLength={500}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                    <label className="checkitem">
                      <input type="checkbox" checked={aiLabeled} onChange={(e) => setAiLabeled(e.target.checked)} />
                      <span>已在平台勾选「AI 生成」标注（如实回填）</span>
                    </label>
                    <input
                      className="noteinput"
                      type="datetime-local"
                      value={publishedAt}
                      onChange={(e) => setPublishedAt(e.target.value)}
                      aria-label="实际发布时间（可选，默认现在）"
                    />
                    <div className="actions">
                      <button className="primary" disabled={submitting || url.trim().length === 0} onClick={() => void submitRecord(item)}>
                        {submitting ? '提交中…' : '回填台账'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {published.length > 0 && (
        <section>
          <h2>已发布台账（V3 归因事实表）</h2>
          {published.map((item) => (
            <div key={item.record.id} className="card off">
              <div>
                <div className="title">
                  <span className={`badge ${item.draft.platform === 'xiaohongshu' ? 'src' : 'strong'}`}>
                    {PLATFORM_LABEL[item.draft.platform]}
                  </span>
                  {item.draft.title} <small className="meta">{item.draft.externalId}</small>
                </div>
                <div className="meta">
                  发布于 {fmtTime(item.record.publishedAt)} ·{' '}
                  {item.record.aiLabeled ? '已标「AI 生成」' : '未标 AI（如实记录）'} ·{' '}
                  {item.record.url ? (
                    <a href={item.record.url} target="_blank" rel="noreferrer noopener">
                      打开作品 ↗
                    </a>
                  ) : (
                    '无链接'
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <footer>发布动作永远人工，本页只做记录与提醒 · 台账 url 经后端 http(s) 白名单校验 · 一条记录只回填一次</footer>
    </main>
  );
}
