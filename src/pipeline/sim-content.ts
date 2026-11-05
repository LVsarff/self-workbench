/**
 * 单内容下钻（模块④ B3 第二批：数据打通层，零 LLM）。
 * 用 sim_play_events（KuaiRec small_matrix 播放级事件）对单条内容做明细分析：
 *   - 完播边界：watch_ratio 分位数（p25/p50/p75/p90）+ watch_ratio≥1 完播占比
 *   - 观看时长分布：play_duration 分位数 + 均值
 * 并关联 sim_content_stats（日粒度台账）取 caption / 类目 / 账号层总量。
 *
 * 红线：所有结论带样本量——small_matrix 是全量数据的子集，
 * 播放级样本量 ≠ 日粒度台账播放量，两者分开呈现、不混用。
 */
import type { Repo, SimContentStatRow, SimPlayEventRow } from '../db/repo.js';
import { SIM_DISCLAIMER } from './sim-dashboard.js';

/** 分位数集合（完播边界用） */
export const QUANTILES = [0.25, 0.5, 0.75, 0.9] as const;

/** 线性插值分位数（输入升序数组，q∈[0,1]；空数组返回 null） */
export function quantile(sorted: number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const qClamped = Math.min(1, Math.max(0, q)); // 对抗防御：q 越界钳到 [0,1]，否则索引越界得 NaN
  const pos = (n - 1) * qClamped;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface SimContentDailyStat {
  date: string;
  showCnt: number;
  playCnt: number;
  completePlayCnt: number;
  likeCnt: number;
  commentCnt: number;
  shareCnt: number;
  followCnt: number;
}

export interface SimContentDrilldown {
  disclaimer: string;
  videoId: string;
  /** 日粒度台账（sim_content_stats）侧：内容元信息 */
  authorId: string | null;
  caption: string | null;
  category: string | null;
  topicTag: string | null;
  uploadDt: string | null;
  /** 日粒度台账汇总（注意：这是台账口径，不是播放级样本口径） */
  stats: {
    /** 日粒度覆盖天数（台账无记录时为 0） */
    days: number;
    showCnt: number;
    playCnt: number;
    completePlayCnt: number;
    /** complete_play / play（play=0 记 0） */
    completeRate: number;
    likeCnt: number;
    commentCnt: number;
    shareCnt: number;
    followCnt: number;
  };
  daily: SimContentDailyStat[];
  /** 播放级样本（sim_play_events）侧：完播边界 + 观看时长分布 */
  playLevel: {
    /** 播放事件样本量（红线：结论必须带这个数） */
    sampleCount: number;
    userCount: number;
    dateFrom: string | null;
    dateTo: string | null;
    /** watch_ratio = play_duration / video_duration（≥1 视为看完） */
    watchRatio: {
      p25: number | null;
      p50: number | null;
      p75: number | null;
      p90: number | null;
      mean: number | null;
      /** watch_ratio ≥ 1 的样本占比（完播占比） */
      completeRatio: number | null;
      /** 参与占比计算的样本量（watch_ratio 非空的行） */
      ratioSampleCount: number;
    };
    /** play_duration（与 video_duration 同单位，比值口径自洽，不做换算） */
    playDuration: {
      p25: number | null;
      p50: number | null;
      p75: number | null;
      p90: number | null;
      mean: number | null;
    };
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function round3(v: number | null): number | null {
  return v == null ? null : Math.round(v * 1000) / 1000;
}

/** 纯计算：播放事件 + 日粒度台账行 → 单内容下钻（不碰 repo，便于测试与复用） */
export function buildSimContentDrilldown(events: SimPlayEventRow[], stats: SimContentStatRow[], videoId: string): SimContentDrilldown {
  // —— 台账侧：元信息 + 汇总 ——
  const meta = stats.find((r) => r.caption != null) ?? stats[0];
  const s = (pick: (r: SimContentStatRow) => number): number => stats.reduce((acc, r) => acc + pick(r), 0);
  const totalPlay = s((r) => r.playCnt);

  // —— 播放级样本侧 ——
  const ratios = events
    .map((e) => e.watchRatio)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const durations = events
    .map((e) => e.playDuration)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const dates = events
    .map((e) => e.watchDate)
    .filter((v): v is string => v != null)
    .sort();
  const meanOf = (arr: number[]): number | null => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);
  const completeSamples = ratios.filter((v) => v >= 1).length;

  return {
    disclaimer: SIM_DISCLAIMER,
    videoId,
    authorId: meta?.authorId ?? null,
    caption: meta?.caption ?? null,
    category: meta?.category ?? null,
    topicTag: meta?.topicTag ?? null,
    uploadDt: meta?.uploadDt ?? null,
    stats: {
      days: stats.length,
      showCnt: s((r) => r.showCnt),
      playCnt: totalPlay,
      completePlayCnt: s((r) => r.completePlayCnt),
      completeRate: rate(s((r) => r.completePlayCnt), totalPlay),
      likeCnt: s((r) => r.likeCnt),
      commentCnt: s((r) => r.commentCnt),
      shareCnt: s((r) => r.shareCnt),
      followCnt: s((r) => r.followCnt),
    },
    daily: [...stats].map((r) => ({
      date: r.statDate,
      showCnt: r.showCnt,
      playCnt: r.playCnt,
      completePlayCnt: r.completePlayCnt,
      likeCnt: r.likeCnt,
      commentCnt: r.commentCnt,
      shareCnt: r.shareCnt,
      followCnt: r.followCnt,
    })),
    playLevel: {
      sampleCount: events.length,
      userCount: new Set(events.map((e) => e.userId)).size,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      watchRatio: {
        p25: round3(quantile(ratios, 0.25)),
        p50: round3(quantile(ratios, 0.5)),
        p75: round3(quantile(ratios, 0.75)),
        p90: round3(quantile(ratios, 0.9)),
        mean: round3(meanOf(ratios)),
        completeRatio: ratios.length > 0 ? round3(completeSamples / ratios.length) : null,
        ratioSampleCount: ratios.length,
      },
      playDuration: {
        p25: round3(quantile(durations, 0.25)),
        p50: round3(quantile(durations, 0.5)),
        p75: round3(quantile(durations, 0.75)),
        p90: round3(quantile(durations, 0.9)),
        mean: round3(meanOf(durations)),
      },
    },
  };
}

export interface SimContentOptions {
  repo: Repo;
  videoId: string;
}

/** 下钻入口：拉播放事件 + 日粒度台账 → 纯计算（内容不存在或两者皆空抛错） */
export async function runSimContent(opts: SimContentOptions): Promise<SimContentDrilldown> {
  const [events, stats] = await Promise.all([
    opts.repo.getSimPlayEventsByVideo(opts.videoId),
    opts.repo.getSimStatsByVideo('kuairec', opts.videoId),
  ]);
  if (events.length === 0 && stats.length === 0) {
    throw new Error(`内容 ${opts.videoId} 没有模拟数据（先执行 gwd sim-import 和 gwd sim-play-import）`);
  }
  return buildSimContentDrilldown(events, stats, opts.videoId);
}
