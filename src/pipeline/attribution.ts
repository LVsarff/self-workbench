/**
 * 内容层表现归因（模块⑤ V3 框架先行第四批，PRD「表现归因：哪个品/哪条内容好或差」的内容层半张脸）。
 *
 * 归因链路：publish_records（已发布，内容↔品↔平台↔时间，V3 归因事实表）
 *   join 真实表现台账 sim_stats source='manual'（real-import 导入的「账号-内容-日」行）
 *   on video_id → 发布后 N 天窗口内的累计表现 → 内容级 / 品级 / 平台级三层汇总。
 *
 * 边界（与全仓口径一致）：
 *   - 零 LLM：纯确定性计算，本模块是读侧报表，不落任何审计
 *   - 红线·双源隔离：join 永远锁 source='manual'——KuaiRec 模拟数据（kuairec）即使 video_id 撞号也不参与归因
 *   - 品归因（成交维度）是后续工作：当前窗口内无「内容↔商品↔成交」链路，结论只到内容表现层；
 *     商品层通道（real-product-import）积累数据后另做成交归因
 *   - 小样本护栏（《场景拆解》3.4：小样本是这个模块的物理定律）：每条结论带样本量；
 *     品级汇总内容数 < 2 时标「样本不足·不排名」，照样展示但不进 Top/Bottom 语义
 *   - 不猜：除零率值 → null（如播放 0 时完播率/互动率为 null，不是 0%）
 */

import type { AttributionPublishRow, Repo } from '../db/repo.js';
import type { Platform } from '../core/types.js';
import { parseVideoId } from '../core/video-id.js';
import { todayShanghai } from '../util.js';

export const ATTRIBUTION_DISCLAIMER =
  '真实通道 · 归因仅内容层（发布台账 join 账号-内容-日表现，按 video_id；无成交归因——商品层成交数据积累后另行分析）';

/** 默认归因窗口：发布后 7 个自然日（stat_date ∈ [发布日, 发布日+6]） */
export const DEFAULT_ATTRIBUTION_DAYS = 7;

/** 品级「样本充足」门槛：<2 条内容只展示不排名（小样本护栏） */
export const PRODUCT_SAMPLE_MIN = 2;

function shanghaiDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(iso));
}

function addDays(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

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

export interface ContentAttributionItem {
  externalId: string;
  title: string | null;
  platform: Platform;
  videoId: string;
  publishedAt: string;
  /** 窗口首日（发布日的上海时区日期） */
  windowFrom: string;
  /** 窗口末日 */
  windowTo: string;
  /** 窗口内有数据的天数（0 不该出现——出现会被归入 issues） */
  statDays: number;
  totals: WindowTotals;
  /** 完播率 = 完播/播放（播放 0 → null，不猜） */
  completeRate: number | null;
  /** 互动率 = (赞+评+转+藏)/播放（播放 0 → null，不猜） */
  interactionRate: number | null;
}

export interface ProductAttributionSummary {
  externalId: string;
  title: string | null;
  /** 该品已发布内容条数（含未归因的） */
  contentCount: number;
  /** 窗口内有表现数据的条数 */
  attributedCount: number;
  platforms: Platform[];
  /** 样本充足（≥ PRODUCT_SAMPLE_MIN 条已归因内容）：才参与好坏排名语义 */
  sampleSufficient: boolean;
  totals: WindowTotals;
  completeRate: number | null;
  interactionRate: number | null;
}

export interface PlatformAttributionSummary {
  platform: Platform;
  attributedCount: number;
  totals: WindowTotals;
}

export interface AttributionIssue {
  /** published 但未回填 video_id（gwd published 时漏了 → gwd attribution-link 补链） */
  noVideoId: Array<{ externalId: string; platform: Platform; publishedAt: string }>;
  /** video_id 已回填但真实台账无该内容数据（先 gwd real-import 导后台数据） */
  noStats: Array<{ externalId: string; platform: Platform; videoId: string }>;
  /** 有历史数据但窗口内 0 天（发布日期填错？或后台尚未导出该区间） */
  outOfWindow: Array<{ externalId: string; platform: Platform; videoId: string; statDays: number }>;
}

export interface AttributionReport {
  days: number;
  generatedAt: string;
  disclaimer: string;
  /** 逐内容归因（按窗口播放降序） */
  contents: ContentAttributionItem[];
  /** 品级汇总（按窗口播放降序；样本不足照样列出但带标记） */
  products: ProductAttributionSummary[];
  /** 平台级汇总 */
  platforms: Array<PlatformAttributionSummary>;
  issues: AttributionIssue;
}

export interface AttributionOptions {
  repo: Repo;
  /** 归因窗口天数（默认 7；1-90 整数） */
  days?: number;
  /** 只看单平台（缺省双平台一起） */
  platform?: Platform;
}

export async function buildAttribution(opts: AttributionOptions): Promise<AttributionReport> {
  const days = opts.days ?? DEFAULT_ATTRIBUTION_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error(`归因窗口天数须为 1-90 的整数（收到: ${days}）`);
  }

  const published = await opts.repo.listPublishedForAttribution();
  // platform 过滤统一在一处生效（内容遍历 / 品级 contentCount / 品级空条目同口径）
  const scoped = opts.platform === undefined ? published : published.filter((r) => r.record.platform === opts.platform);
  const contents: ContentAttributionItem[] = [];
  const issues: AttributionIssue = { noVideoId: [], noStats: [], outOfWindow: [] };

  for (const { record, externalId, title } of scoped) {
    if (opts.platform !== undefined && record.platform !== opts.platform) continue;
    if (record.videoId == null) {
      issues.noVideoId.push({ externalId, platform: record.platform, publishedAt: record.publishedAt! });
      continue;
    }

    // 红线：join 锁 source='manual'——模拟数据 kuairec 同 video_id 也永不参与
    const allRows = await opts.repo.getSimStatsByVideo('manual', record.videoId);
    if (allRows.length === 0) {
      issues.noStats.push({ externalId, platform: record.platform, videoId: record.videoId });
      continue;
    }

    const windowFrom = shanghaiDateOf(record.publishedAt!);
    const windowTo = addDays(windowFrom, days - 1);
    const rows = allRows.filter((r) => r.statDate >= windowFrom && r.statDate <= windowTo);
    if (rows.length === 0) {
      issues.outOfWindow.push({ externalId, platform: record.platform, videoId: record.videoId, statDays: allRows.length });
      continue;
    }

    const totals: WindowTotals = {
      showCnt: rows.reduce((s, r) => s + r.showCnt, 0),
      playCnt: rows.reduce((s, r) => s + r.playCnt, 0),
      completePlayCnt: rows.reduce((s, r) => s + r.completePlayCnt, 0),
      likeCnt: rows.reduce((s, r) => s + r.likeCnt, 0),
      commentCnt: rows.reduce((s, r) => s + r.commentCnt, 0),
      shareCnt: rows.reduce((s, r) => s + r.shareCnt, 0),
      followCnt: rows.reduce((s, r) => s + r.followCnt, 0),
      collectCnt: rows.reduce((s, r) => s + r.collectCnt, 0),
    };
    contents.push({
      externalId,
      title,
      platform: record.platform,
      videoId: record.videoId,
      publishedAt: record.publishedAt!,
      windowFrom,
      windowTo,
      statDays: rows.length,
      totals,
      completeRate: totals.playCnt === 0 ? null : totals.completePlayCnt / totals.playCnt,
      interactionRate: totals.playCnt === 0 ? null : (totals.likeCnt + totals.commentCnt + totals.shareCnt + totals.collectCnt) / totals.playCnt,
    });
  }

  contents.sort((a, b) => b.totals.playCnt - a.totals.playCnt || a.externalId.localeCompare(b.externalId));

  // 品级聚合（比率用分子分母各自的和——比率之和的平均会被单条爆款带偏）
  const byProduct = new Map<string, { externalId: string; title: string | null; items: ContentAttributionItem[] }>();
  for (const c of contents) {
    const entry = byProduct.get(c.externalId) ?? { externalId: c.externalId, title: c.title, items: [] };
    entry.items.push(c);
    byProduct.set(c.externalId, entry);
  }
  // 「已发布但未归因」的品也要出现（不然问题品在报表里隐身）
  for (const { externalId, title } of scoped) {
    if (!byProduct.has(externalId)) byProduct.set(externalId, { externalId, title, items: [] });
  }

  const products: ProductAttributionSummary[] = [...byProduct.values()].map((p) => {
    const totals: WindowTotals = p.items.reduce(
      (acc, it) => ({
        showCnt: acc.showCnt + it.totals.showCnt,
        playCnt: acc.playCnt + it.totals.playCnt,
        completePlayCnt: acc.completePlayCnt + it.totals.completePlayCnt,
        likeCnt: acc.likeCnt + it.totals.likeCnt,
        commentCnt: acc.commentCnt + it.totals.commentCnt,
        shareCnt: acc.shareCnt + it.totals.shareCnt,
        followCnt: acc.followCnt + it.totals.followCnt,
        collectCnt: acc.collectCnt + it.totals.collectCnt,
      }),
      { showCnt: 0, playCnt: 0, completePlayCnt: 0, likeCnt: 0, commentCnt: 0, shareCnt: 0, followCnt: 0, collectCnt: 0 },
    );
    return {
      externalId: p.externalId,
      title: p.title,
      contentCount: scoped.filter((r) => r.externalId === p.externalId).length,
      attributedCount: p.items.length,
      platforms: [...new Set(p.items.map((i) => i.platform))],
      sampleSufficient: p.items.length >= PRODUCT_SAMPLE_MIN,
      totals,
      completeRate: totals.playCnt === 0 ? null : totals.completePlayCnt / totals.playCnt,
      interactionRate: totals.playCnt === 0 ? null : (totals.likeCnt + totals.commentCnt + totals.shareCnt + totals.collectCnt) / totals.playCnt,
    };
  });
  products.sort((a, b) => b.totals.playCnt - a.totals.playCnt || a.externalId.localeCompare(b.externalId));

  // 平台级汇总
  const byPlatform = new Map<Platform, { totals: WindowTotals; count: number }>();
  for (const c of contents) {
    const entry = byPlatform.get(c.platform) ?? { totals: { showCnt: 0, playCnt: 0, completePlayCnt: 0, likeCnt: 0, commentCnt: 0, shareCnt: 0, followCnt: 0, collectCnt: 0 }, count: 0 };
    entry.totals.showCnt += c.totals.showCnt;
    entry.totals.playCnt += c.totals.playCnt;
    entry.totals.completePlayCnt += c.totals.completePlayCnt;
    entry.totals.likeCnt += c.totals.likeCnt;
    entry.totals.commentCnt += c.totals.commentCnt;
    entry.totals.shareCnt += c.totals.shareCnt;
    entry.totals.followCnt += c.totals.followCnt;
    entry.totals.collectCnt += c.totals.collectCnt;
    entry.count += 1;
    byPlatform.set(c.platform, entry);
  }
  const platforms: PlatformAttributionSummary[] = [...byPlatform.entries()].map(([platform, e]) => ({ platform, attributedCount: e.count, totals: e.totals }));

  return {
    days,
    generatedAt: new Date().toISOString(),
    disclaimer: ATTRIBUTION_DISCLAIMER,
    contents,
    products,
    platforms,
    issues,
  };
}

// —— video_id 补链（发布时漏带 → 归因前补；幂等可重跑，人工修正允许覆盖）——

export interface LinkVideoIdOptions {
  repo: Repo;
  date?: string;
  externalId: string;
  platform: Platform;
  videoId: string;
}

export interface LinkVideoIdResult {
  date: string;
  externalId: string;
  platform: Platform;
  videoId: string;
}

/**
 * 给已发布记录补链/修正 video_id（归因 join 锚点不是合规审计字段：一条只回填一次的是链接/时间/AI 标注，
 * video_id 允许后补与人工修正——发布时不存在的 id，发布后才能从平台拿到）。
 */
export async function linkVideoId(opts: LinkVideoIdOptions): Promise<LinkVideoIdResult> {
  const date = opts.date ?? todayShanghai();
  const parsed = parseVideoId(opts.videoId);
  if (!parsed.ok) throw new Error(parsed.error);

  const drafts = await opts.repo.getContentDrafts(date);
  const draft = drafts.find((d) => d.externalId === opts.externalId && d.platform === opts.platform);
  if (!draft) {
    throw new Error(`${date} 没有找到 ${opts.externalId} 的${opts.platform === 'xiaohongshu' ? '小红书' : '抖音'}草稿（先 gwd content-gen + confirm + publish-sync）`);
  }
  const records = await opts.repo.getPublishRecords(date);
  const record = records.find((r) => r.draftId === draft.id);
  if (!record) throw new Error(`${opts.externalId} 没有发布记录（先 gwd publish-sync）`);
  if (record.status !== 'published') {
    throw new Error(`${opts.externalId} 尚未回填发布（先 gwd published 回填链接；video_id 在发布后才能从平台拿到）`);
  }

  await opts.repo.setPublishVideoId(record.id, parsed.value);
  return { date, externalId: opts.externalId, platform: opts.platform, videoId: parsed.value };
}
