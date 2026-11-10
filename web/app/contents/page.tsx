'use client';

/**
 * 内容确认页（门③ Web 化，模块②）：
 * - 拉取 /api/contents（双版草稿 + L2 审查提示 / 去重提示 / 修订轮数，全部只读展示）
 * - 5 项清单逐项勾选（清单文案来自后端单一事实源）→ POST /api/confirm（决策 append-only 留痕）
 * - 弃用 → POST /api/discard（同样留痕）；发布仍是人工动作，本页面不做任何发布
 * - banned_hits 命中 = 硬拦截：前端禁用确认按钮（后端二次拦截兜底）
 * - 所有文本经 React 转义渲染，不拼接原始 HTML（静态门禁测试兜底）
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
type DraftStatus = 'draft' | 'needs_manual' | 'confirmed' | 'discarded';

interface XiaohongshuNote {
  title: string;
  body: string;
  tags: string[];
  coverIdea: string | null;
}

interface DouyinScript {
  hook: string;
  points: string[];
  cta: string;
}

interface ContentRisk {
  type: 'absolute' | 'medical' | 'exaggeration' | 'fabricated_data' | 'other';
  detail: string;
}

interface ContentReviewRecord {
  pass: boolean | null;
  risks: ContentRisk[];
  model: string;
  skippedReason?: string;
}

interface DuplicateHit {
  externalId: string;
  batchDate: string;
  title: string;
  similarity: number;
}

interface Draft {
  id: string;
  runId: string;
  batchDate: string;
  productId: string;
  platform: Platform;
  status: DraftStatus;
  content: XiaohongshuNote | DouyinScript | null;
  bannedHits: string[];
  review: ContentReviewRecord | null;
  duplicates: DuplicateHit[];
  revisionCount: number;
  note: string | null;
  source: 'llm' | 'manual';
  createdAt: string;
  externalId: string;
  title: string;
}

interface ContentsResult {
  date: string;
  checklist: string[];
  drafts: Draft[];
}

const PLATFORM_LABEL: Record<Platform, string> = { xiaohongshu: '小红书', douyin: '抖音' };
const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: '待确认',
  needs_manual: '需人工撰写',
  confirmed: '✅ 已确认',
  discarded: '🗑 已弃用',
};
const RISK_LABEL: Record<string, string> = {
  absolute: '绝对化用语',
  medical: '医疗功效',
  exaggeration: '夸大宣传',
  fabricated_data: '编造数据',
  other: '其他',
};
const SRC_LABEL: Record<string, string> = { llm: 'AI 生成', manual: '人工' };

/** 判断草稿内容结构（同一字段存双平台两种形态） */
function isXhs(c: XiaohongshuNote | DouyinScript | null): c is XiaohongshuNote {
  return c != null && 'body' in c;
}

export default function ContentsPage() {
  const [date, setDate] = usePersistentState<string>('gwd:contents:date', new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<ContentsResult | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null); // `${externalId}:${platform}`
  const [checked, setChecked] = useState<boolean[]>([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 首挂载读一次 ?date=（post-mount，URL 显式指定优先于 localStorage 记忆）
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
      const res = await fetch(`${API}/api/contents?date=${d}`, { headers: authHeaders() });
      const body = await res.json();
      if (!res.ok) {
        setData(null);
        setError(body?.error ?? `请求失败（${res.status}）`);
        return;
      }
      setData(body as ContentsResult);
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

  function openDraft(d: Draft) {
    const key = `${d.externalId}:${d.platform}`;
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    setChecked(new Array(data?.checklist.length ?? 5).fill(false));
    setNote('');
    setError(null);
  }

  const allChecked = data != null && checked.length === data.checklist.length && checked.every(Boolean);

  async function submitConfirm(d: Draft) {
    if (!data) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/confirm`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ date, externalId: d.externalId, platform: d.platform, answers: checked, note: note || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `提交失败（${res.status}）`);
        return;
      }
      setNotice(`门③ 通过：${d.externalId} ${PLATFORM_LABEL[d.platform]} 已确认（决策 append-only 留痕）。发布仍是人工动作：复制内容 → 平台发布并勾选「AI 生成」标注。`);
      await load(date);
      setOpenKey(null);
    } catch (e) {
      setError(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitDiscard(d: Draft) {
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API}/api/discard`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ date, externalId: d.externalId, platform: d.platform, note: note || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `提交失败（${res.status}）`);
        return;
      }
      setNotice(`已弃用 ${d.externalId} ${PLATFORM_LABEL[d.platform]}（决策 append-only 留痕）。如需重做：gwd content-gen --force`);
      await load(date);
      setOpenKey(null);
    } catch (e) {
      setError(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const drafts = data?.drafts ?? [];
  const pending = drafts.filter((d) => d.status === 'draft' || d.status === 'needs_manual');
  const done = drafts.filter((d) => d.status === 'confirmed' || d.status === 'discarded');

  return (
    <main className="wrap wide">
      <header className="top">
        <h1>内容确认（门③）</h1>
        <span className="sub">
          合规最后关口 · <a href="/">← 今日总览</a>
        </span>
      </header>

      <div className="toolbar">
        <DateQuick value={date} onChange={setDate} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button onClick={() => void load(date)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
        {data && (
          <span className="sub">
            {drafts.length} 条草稿 · 待处理 {pending.length}
          </span>
        )}
      </div>

      {error && <div className="msg error">{error}</div>}
      {notice && <div className="msg ok">{notice}</div>}

      {!data && !loading && (
        <div className="empty">
          <p>这一天没有内容草稿。</p>
          <p>
            先跑流水线：<code>npm run gwd -- select</code> → <code>npm run gwd -- content-gen</code>
          </p>
        </div>
      )}

      {data && drafts.length === 0 && !loading && (
        <div className="empty">
          <p>这一天没有内容草稿。</p>
          <p>
            先跑流水线：<code>npm run gwd -- select</code> → <code>npm run gwd -- content-gen</code>
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <section>
          <h2>待确认（点开草稿 → 核对 5 项清单）</h2>
          {pending.map((d) => {
            const key = `${d.externalId}:${d.platform}`;
            const open = openKey === key;
            const blocked = d.bannedHits.length > 0 || d.status === 'needs_manual';
            return (
              <div key={key} className={`card${open ? ' picked' : ''} draftcard`}>
                <button className="draftopen" onClick={() => openDraft(d)}>
                  <span className={`badge ${d.platform === 'xiaohongshu' ? 'src' : 'strong'}`}>{PLATFORM_LABEL[d.platform]}</span>
                  <span className="title">
                    {d.title} <small className="meta">{d.externalId}</small>
                  </span>
                  <span className={`badge ${d.status === 'needs_manual' ? 'drop' : 'test'}`}>{STATUS_LABEL[d.status]}</span>
                  {d.bannedHits.length > 0 && <span className="badge drop">⚠ 词表命中 {d.bannedHits.length}</span>}
                  {d.review != null && d.review.risks.length > 0 && <span className="badge drop">⚠ 审查提示 {d.review.risks.length}</span>}
                  {d.duplicates.length > 0 && <span className="badge drop">⚠ 疑似重复 {d.duplicates.length}</span>}
                  <span className="meta">{open ? '收起 ▲' : '展开 ▼'}</span>
                </button>

                {open && (
                  <div className="draftbody">
                    {/* 自检发现：词表硬拦截 / L2 审查提示 / 历史去重——人看着这些做终判 */}
                    {d.bannedHits.length > 0 && (
                      <div className="msg error">词表命中（硬拦截，不能确认）: {d.bannedHits.join('、')} —— 请先 gwd content-gen --force 重新生成</div>
                    )}
                    {d.status === 'needs_manual' && (
                      <div className="msg error">
                        草稿内容为空（需人工撰写/重新生成），不能确认{d.note ? ` · ${d.note}` : ''} —— 请先 gwd content-gen --force
                      </div>
                    )}
                    {d.review != null && d.review.risks.length > 0 && (
                      <div className="reviewbox">
                        <b>L2 审查提示（不拦截，清单第 2 项里终判；审查器 {d.review.model}）</b>
                        {d.review.risks.map((r, i) => (
                          <div key={i}>
                            · [{RISK_LABEL[r.type] ?? r.type}] {r.detail}
                          </div>
                        ))}
                      </div>
                    )}
                    {d.review != null && d.review.risks.length === 0 && (
                      <p className="empty-inline">L2 审查通过（审查器 {d.review.model}）{d.review.pass === null && d.review.skippedReason ? ` · ${d.review.skippedReason}` : ''}</p>
                    )}
                    {d.duplicates.length > 0 && (
                      <div className="reviewbox">
                        <b>历史去重提示（相似度超阈值，触发过修订）</b>
                        {d.duplicates.map((h, i) => (
                          <div key={i}>
                            · {h.batchDate} {h.externalId}「{h.title}」相似度 {(h.similarity * 100).toFixed(0)}%
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 双版草稿正文（React 转义渲染，红线：AI 内容必须人确认后才用） */}
                    {d.content != null && (
                      <div className="contentbox">
                        <div className="meta">
                          {SRC_LABEL[d.source] ?? d.source} · 修订 {d.revisionCount} 轮
                        </div>
                        {isXhs(d.content) ? (
                          <>
                            <div className="title">{d.content.title}</div>
                            <p className="body">{d.content.body}</p>
                            <div className="tagsrow">{d.content.tags.map((t) => `#${t}`).join(' ')}</div>
                            {d.content.coverIdea && <div className="meta">封面思路：{d.content.coverIdea}</div>}
                          </>
                        ) : (
                          <>
                            <div className="title">【钩子】{d.content.hook}</div>
                            {d.content.points.map((p, i) => (
                              <p className="body" key={i}>
                                · {p}
                              </p>
                            ))}
                            <div className="body">【CTA】{d.content.cta}</div>
                          </>
                        )}
                      </div>
                    )}

                    {/* 5 项清单：来自后端单一事实源，全部勾选才能确认 */}
                    {d.status === 'draft' && (
                      <div className="checklist">
                        <b>门③ 5 项确认清单（逐项核对，全部勾选才能通过）</b>
                        {(data?.checklist ?? []).map((item, i) => (
                          <label key={i} className="checkitem">
                            <input
                              type="checkbox"
                              checked={checked[i] ?? false}
                              disabled={d.bannedHits.length > 0}
                              onChange={() => setChecked((prev) => prev.map((v, j) => (j === i ? !v : v)))}
                            />
                            <span>
                              {i + 1}. {item}
                            </span>
                          </label>
                        ))}
                        <input
                          className="noteinput"
                          type="text"
                          placeholder="备注（可选，写入决策流水）"
                          value={note}
                          maxLength={500}
                          onChange={(e) => setNote(e.target.value)}
                        />
                        <div className="actions">
                          <button
                            className="primary"
                            disabled={submitting || !allChecked || d.bannedHits.length > 0}
                            onClick={() => void submitConfirm(d)}
                          >
                            {submitting ? '提交中…' : '确认通过门③'}
                          </button>
                          <button className="ghost" disabled={submitting} onClick={() => void submitDiscard(d)}>
                            弃用这份草稿
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2>已处理</h2>
          {done.map((d) => (
            <div key={`${d.externalId}:${d.platform}`} className="card off">
              <div>
                <div className="title">
                  <span className={`badge ${d.platform === 'xiaohongshu' ? 'src' : 'strong'}`}>{PLATFORM_LABEL[d.platform]}</span>
                  {d.title} <small className="meta">{d.externalId}</small>
                  <span className="badge drop">{STATUS_LABEL[d.status]}</span>
                </div>
                {d.note && <div className="meta">{d.note}</div>}
              </div>
            </div>
          ))}
        </section>
      )}

      <footer>确认/弃用决策 append-only 落库 · AI 内容必须人工确认后才使用 · 发布保持人工（复制内容 → 平台发布并勾「AI 生成」标注）</footer>
    </main>
  );
}
