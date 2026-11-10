'use client';

/**
 * 归因报表页（独立页，与数据看板并列）：
 * - 两个只读归因报表，页签切换：
 *   · 内容层归因  GET /api/attribution?days=&platform=  （逐内容 / 品级 / 平台 三层）
 *   · 品级成交归因  GET /api/product-attribution?days=  （点击/加购/订单/GMV/佣金/转化率）
 * - 红线：声明横幅来自后端（disclaimer），前端不二次加工；本页只读，零写入
 * - 关键口径显眼呈现：金额累加回两位小数；成交归因仅品级（勿从均摊反推单条）；点击 0 → 率值 null；小样本不排名；未归因逐条给原因
 * - 所有文本经 React 转义渲染，禁止拼接原始 HTML（静态门禁测试兜底）
 */
import { useCallback, useEffect, useState } from 'react';
import { usePersistentState } from '../lib/usePersistentState';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN;

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { 'x-api-token': API_TOKEN } : {};
}

type Platform = 'xiaohongshu' | 'douyin';
type Tab = 'content' | 'deal';

// —— 内容层归因（/api/attribution）——
interface WindowTotals {
  showCnt: number;
  playCnt: number;
  completePlayCnt: number;
  likeCnt: number;
  commentCnt: number;
  shareCnt: number;
  followCnt: number;
  collectCnt: number;
}

interface ContentAttributionItem {
  externalId: string;
  title: string | null;
  platform: Platform;
  videoId: string;
  publishedAt: string;
  windowFrom: string;
  windowTo: string;
  statDays: number;
  totals: WindowTotals;
  completeRate: number | null;
  interactionRate: number | null;
}

interface ProductAttributionSummary {
  externalId: string;
  title: string | null;
  contentCount: number;
  attributedCount: number;
  platforms: Platform[];
  sampleSufficient: boolean;
  totals: WindowTotals;
  completeRate: number | null;
  interactionRate: number | null;
}

interface PlatformAttributionSummary {
  platform: Platform;
  attributedCount: number;
  totals: WindowTotals;
}

interface AttributionIssue {
  noVideoId: Array<{ externalId: string; platform: Platform; publishedAt: string }>;
  noStats: Array<{ externalId: string; platform: Platform; videoId: string }>;
  outOfWindow: Array<{ externalId: string; platform: Platform; videoId: string; statDays: number }>;
}

interface AttributionReport {
  days: number;
  generatedAt: string;
  disclaimer: string;
  contents: ContentAttributionItem[];
  products: ProductAttributionSummary[];
  platforms: PlatformAttributionSummary[];
  issues: AttributionIssue;
}

// —— 品级成交归因（/api/product-attribution）——
interface PerfTotals {
  clickCnt: number;
  addCartCnt: number;
  orderCnt: number;
  gmvAmount: number;
  commissionAmount: number;
}

interface ProductDealAttributionItem {
  externalId: string;
  title: string | null;
  contentCount: number;
  platforms: Platform[];
  firstPublishedAt: string;
  windowFrom: string;
  windowTo: string;
  statDays: number;
  totals: PerfTotals;
  addCartRate: number | null;
  orderRate: number | null;
  gmvPerContent: number | null;
  sampleSufficient: boolean;
  contents: Array<{ platform: Platform; publishedAt: string; videoId: string | null }>;
}

interface ProductAttributionIssue {
  noPerfData: Array<{ externalId: string; contentCount: number }>;
  outOfWindow: Array<{ externalId: string; statDays: number }>;
  perfNoPublish: Array<{ productId: string; productTitle: string | null; gmvAmount: number }>;
}

interface ProductAttributionReport {
  days: number;
  generatedAt: string;
  disclaimer: string;
  products: ProductDealAttributionItem[];
  issues: ProductAttributionIssue;
}

const PLATFORM_LABEL: Record<Platform, string> = { xiaohongshu: '小红书', douyin: '抖音' };

/** 大数转「万」；红线：缺失显示 '-'，不编造 */
function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '-';
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

/** 金额：固定两位小数（对账口径），缺失 '-' */
function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '-';
  return `￥${n.toFixed(2)}`;
}

/** 率值：null → '-'（不猜 0%），否则两位小数百分比 */
function pct(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return '-';
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function AttributionPage() {
  const [tab, setTab] = useState<Tab>('content');
  const [days, setDays] = usePersistentState<number>('gwd:attribution:days', 7);
  const [platform, setPlatform] = usePersistentState<'' | Platform>('gwd:attribution:platform', '');
  const [content, setContent] = useState<AttributionReport | null>(null);
  const [deal, setDeal] = useState<ProductAttributionReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (t: Tab, d: number, p: '' | Platform) => {
    setLoading(true);
    setError(null);
    try {
      if (t === 'content') {
        const qs = new URLSearchParams();
        qs.set('days', String(d));
        if (p) qs.set('platform', p);
        const res = await fetch(`${API}/api/attribution?${qs.toString()}`, { headers: authHeaders() });
        const body = await res.json();
        if (!res.ok) {
          setContent(null);
          setError(body?.error ?? `请求失败（${res.status}）`);
          return;
        }
        setContent(body as AttributionReport);
      } else {
        const res = await fetch(`${API}/api/product-attribution?days=${d}`, { headers: authHeaders() });
        const body = await res.json();
        if (!res.ok) {
          setDeal(null);
          setError(body?.error ?? `请求失败（${res.status}）`);
          return;
        }
        setDeal(body as ProductAttributionReport);
      }
    } catch (e) {
      if (t === 'content') setContent(null);
      else setDeal(null);
      setError(`连不上后端（${API}）：${e instanceof Error ? e.message : String(e)}。先启动 API：npm run api`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab, days, platform);
  }, [tab, days, platform, load]);

  function switchTab(next: Tab) {
    setTab(next);
    setError(null);
    // 成交归因默认窗口 30 天，切换时若沿用 7 天会漏掉长周期成交；给个合理默认
    if (next === 'deal' && days === 7) setDays(30);
    if (next === 'content') setPlatform('');
  }

  return (
    <main className="wrap wide">
      <header className="top">
        <h1>归因报表</h1>
        <span className="sub">
          内容层表现 + 品级成交 · 只读 · <a href="/">← 今日总览</a>
        </span>
      </header>

      <div className="toolbar">
        <div className="seg">
          <button className={tab === 'content' ? 'on' : ''} onClick={() => switchTab('content')}>
            内容层归因
          </button>
          <button className={tab === 'deal' ? 'on' : ''} onClick={() => switchTab('deal')}>
            品级成交归因
          </button>
        </div>
        <label className="sub" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          窗口
          <input
            type="number"
            min={1}
            max={90}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 7)))}
            style={{ width: 64, border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', fontSize: 13 }}
          />
          天
        </label>
        {tab === 'content' && (
          <div className="seg">
            <button className={platform === '' ? 'on' : ''} onClick={() => setPlatform('')}>
              双平台
            </button>
            <button className={platform === 'xiaohongshu' ? 'on' : ''} onClick={() => setPlatform('xiaohongshu')}>
              小红书
            </button>
            <button className={platform === 'douyin' ? 'on' : ''} onClick={() => setPlatform('douyin')}>
              抖音
            </button>
          </div>
        )}
        <button onClick={() => void load(tab, days, platform)} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>

      {error && <div className="msg error">{error}</div>}

      {/* 内容层归因 */}
      {tab === 'content' && content && (
        <>
          <div className="banner real">{content.disclaimer}</div>
          <p className="range">
            归因窗口 {content.days} 天 · 生成于 {fmtTime(content.generatedAt)} · 逐内容按窗口播放降序
          </p>

          <IssuesBlock
            noVideoId={content.issues.noVideoId}
            noStats={content.issues.noStats}
            outOfWindow={content.issues.outOfWindow}
          />

          {content.contents.length > 0 && (
            <section>
              <h2>逐内容归因（{content.contents.length} 条）</h2>
              {content.contents.map((c, i) => (
                <div key={`${c.externalId}:${c.videoId}`} className="card">
                  <div className="rank">{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div className="title">
                      {c.title ?? c.videoId} <small className="meta">{c.externalId}</small>
                    </div>
                    <div className="meta">
                      {PLATFORM_LABEL[c.platform]} · {c.videoId} · 发布 {c.publishedAt.slice(0, 10)} · 窗口 {c.windowFrom} ~ {c.windowTo}（{c.statDays} 天）
                    </div>
                    <div className="meta">
                      曝光 {fmt(c.totals.showCnt)} · 播放 {fmt(c.totals.playCnt)} · 完播 {pct(c.completeRate)} · 互动 {pct(c.interactionRate)} · 赞 {fmt(c.totals.likeCnt)} · 评 {fmt(c.totals.commentCnt)} · 转 {fmt(c.totals.shareCnt)} · 藏 {fmt(c.totals.collectCnt)} · 涨粉 {fmt(c.totals.followCnt)}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}

          {content.products.length > 0 && (
            <section>
              <h2>品级汇总（内容层表现）</h2>
              {content.products.map((p) => (
                <div key={p.externalId} className={`card${p.sampleSufficient ? '' : ' off'}`}>
                  <div style={{ flex: 1 }}>
                    <div className="title">
                      {p.title ?? p.externalId} <small className="meta">{p.externalId}</small>
                      {!p.sampleSufficient && <span className="badge drop">样本不足 · 不排名</span>}
                    </div>
                    <div className="meta">
                      已发布 {p.contentCount} 条 · 已归因 {p.attributedCount} 条 · {p.platforms.map((pl) => PLATFORM_LABEL[pl]).join('/')}
                    </div>
                    <div className="meta">
                      曝光 {fmt(p.totals.showCnt)} · 播放 {fmt(p.totals.playCnt)} · 完播 {pct(p.completeRate)} · 互动 {pct(p.interactionRate)}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}

          {content.platforms.length > 0 && (
            <section>
              <h2>平台级汇总</h2>
              {content.platforms.map((pl) => (
                <div key={pl.platform} className="card">
                  <div style={{ flex: 1 }}>
                    <div className="title">{PLATFORM_LABEL[pl.platform]}</div>
                    <div className="meta">
                      已归因 {pl.attributedCount} 条 · 曝光 {fmt(pl.totals.showCnt)} · 播放 {fmt(pl.totals.playCnt)}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {/* 品级成交归因 */}
      {tab === 'deal' && deal && (
        <>
          <div className="banner real">{deal.disclaimer}</div>
          <p className="range">
            归因窗口 {deal.days} 天（起点 = 该品首条内容发布日）· 生成于 {fmtTime(deal.generatedAt)} · 品级按窗口 GMV 降序
          </p>

          {deal.issues.noPerfData.length > 0 && (
            <div className="reviewbox">
              <b>未归因 · 商品层台账无数据（无行 ≠ 0 成交，如实提示）</b>
              {deal.issues.noPerfData.map((i) => (
                <div key={i.externalId}>· {i.externalId}（已发布 {i.contentCount} 条）</div>
              ))}
            </div>
          )}
          {deal.issues.outOfWindow.length > 0 && (
            <div className="reviewbox">
              <b>未归因 · 窗口内 0 天（首条发布日填错？或后台尚未导出该区间）</b>
              {deal.issues.outOfWindow.map((i) => (
                <div key={i.externalId}>· {i.externalId}（有历史 {i.statDays} 天，但窗口内 0 天）</div>
              ))}
            </div>
          )}
          {deal.issues.perfNoPublish.length > 0 && (
            <div className="reviewbox">
              <b>反向核对 · 后台有成交但发布台账无该品（选品池外直接挂车 / external_id 不一致）</b>
              {deal.issues.perfNoPublish.map((i) => (
                <div key={i.productId}>
                  · {i.productId}（{i.productTitle ?? '无标题'}）GMV {money(i.gmvAmount)}
                </div>
              ))}
            </div>
          )}

          {deal.products.length > 0 && (
            <section>
              <h2>品级成交归因（{deal.products.length} 个品）</h2>
              {deal.products.map((p, i) => (
                <div key={p.externalId} className={`card${p.sampleSufficient ? '' : ' off'}`}>
                  <div className="rank">{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div className="title">
                      {p.title ?? p.externalId} <small className="meta">{p.externalId}</small>
                      {!p.sampleSufficient && <span className="badge drop">样本不足 · 不排名</span>}
                    </div>
                    <div className="meta">
                      已发布 {p.contentCount} 条 · {p.platforms.map((pl) => PLATFORM_LABEL[pl]).join('/')} · 首条发布 {p.firstPublishedAt.slice(0, 10)} · 窗口 {p.windowFrom} ~ {p.windowTo}（{p.statDays} 天）
                    </div>
                    <div className="meta">
                      点击 {fmt(p.totals.clickCnt)} · 加购 {fmt(p.totals.addCartCnt)} · 订单 {fmt(p.totals.orderCnt)} · 加购率 {pct(p.addCartRate)} · 成交转化率 {pct(p.orderRate)}
                    </div>
                    <div className="meta">
                      GMV <b style={{ color: 'var(--brand)' }}>{money(p.totals.gmvAmount)}</b> · 佣金 {money(p.totals.commissionAmount)} · 每内容均摊 GMV {money(p.gmvPerContent)}
                      <span style={{ color: 'var(--muted)' }}>（均摊仅参考，勿反推单条效果）</span>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {tab === 'content' && !content && !loading && !error && (
        <div className="empty">
          <p>暂无内容层归因数据。</p>
          <p>
            先回填发布台账并补 video_id：<code>npm run gwd -- published</code> → <code>npm run gwd -- attribution-link</code>
          </p>
        </div>
      )}
      {tab === 'deal' && !deal && !loading && !error && (
        <div className="empty">
          <p>暂无品级成交归因数据。</p>
          <p>
            先导入商品层表现：<code>npm run gwd -- real-product-import products.csv</code>（source 锁 manual）
          </p>
        </div>
      )}

      <footer>归因报表只读 · 成交归因仅品级（联盟数据无内容维度）· 单条内容效果看「内容层归因」</footer>
    </main>
  );
}

/** 内容层未归因三类：逐条给原因，不静默跳过 */
function IssuesBlock({
  noVideoId,
  noStats,
  outOfWindow,
}: {
  noVideoId: AttributionIssue['noVideoId'];
  noStats: AttributionIssue['noStats'];
  outOfWindow: AttributionIssue['outOfWindow'];
}) {
  if (noVideoId.length === 0 && noStats.length === 0 && outOfWindow.length === 0) return null;
  return (
    <div className="reviewbox">
      {noVideoId.length > 0 && (
        <>
          <b>未归因 · 已发布但未回填 video_id（补链：gwd attribution-link）</b>
          {noVideoId.map((i) => (
            <div key={`${i.externalId}:${i.platform}`}>
              · {i.externalId}（{PLATFORM_LABEL[i.platform]}）发布 {i.publishedAt.slice(0, 10)}
            </div>
          ))}
        </>
      )}
      {noStats.length > 0 && (
        <>
          <b>未归因 · 真实台账无该内容数据（先 gwd real-import 导后台）</b>
          {noStats.map((i) => (
            <div key={`${i.externalId}:${i.platform}:${i.videoId}`}>
              · {i.externalId}（{PLATFORM_LABEL[i.platform]}）video {i.videoId}
            </div>
          ))}
        </>
      )}
      {outOfWindow.length > 0 && (
        <>
          <b>未归因 · 有历史数据但窗口内 0 天（发布日期填错？或后台未导出该区间）</b>
          {outOfWindow.map((i) => (
            <div key={`${i.externalId}:${i.platform}:${i.videoId}`}>
              · {i.externalId}（{PLATFORM_LABEL[i.platform]}）video {i.videoId}（历史 {i.statDays} 天）
            </div>
          ))}
        </>
      )}
    </div>
  );
}
