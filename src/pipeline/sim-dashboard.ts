/**
 * 模拟数据账号看板（模块④ B3 第一批：数据打通层，零 LLM）。
 * 把 sim_content_stats 按「账号」聚合：日趋势（曝光/播放/完播率/互动率/涨粉）、
 * Top 内容、曝光环比异常日。所有输出必须带 SIM_DISCLAIMER 声明（红线：模拟≠真实）。
 *
 * 口径（对齐抖音创作者后台）：
 *   - 完播率 = complete_play_cnt / play_cnt（播放为 0 时记 0，不除零）
 *   - 互动率 = (like + comment + share) / play_cnt
 *   - 涨粉 = follow_cnt 日汇总
 *   - 异常日 = 曝光环比变动幅度 ≥ ANOMALY_THRESHOLD（默认 ±50%，方向标注涨/跌）
 */
import type { Repo, SimContentStatRow } from '../db/repo.js';

/** 所有看板输出必带的红线声明 */
export const SIM_DISCLAIMER = '模拟数据 · 方法已验证、参数未验证（KuaiRec 2.0 开源数据，非本人账号）';

/** 曝光环比异常阈值（|当日-前日|/前日 ≥ 0.5 视为异常日） */
export const ANOMALY_THRESHOLD = 0.5;

/**
 * 异常日降噪最小曝光门槛（B3 第二批）：前日曝光低于该值不参与环比判定。
 * 依据：头部账号日曝光中位数约 208 万、min 12——小基数天（如 12→18）±50% 无意义。
 * 门槛取 1 万：滤掉小基数噪声，又不影响正常量级日。
 */
export const MIN_SHOW_BASELINE = 10000;

/** Top 内容展示数量 */
export const TOP_CONTENT_LIMIT = 5;

export interface SimDailyPoint {
  date: string;
  showCnt: number;
  playCnt: number;
  /** complete_play / play（play=0 记 0） */
  completeRate: number;
  /** (like+comment+share) / play（play=0 记 0） */
  interactionRate: number;
  followCnt: number;
}

export interface SimTopContent {
  videoId: string;
  caption: string | null;
  category: string | null;
  uploadDt: string | null;
  showCnt: number;
  playCnt: number;
  completeRate: number;
  likeCnt: number;
}

export interface SimAnomalyDay {
  date: string;
  previousShow: number;
  showCnt: number;
  /** (当日-前日)/前日，正=涨负=跌 */
  changePct: number;
  direction: 'up' | 'down';
}

export interface SimDashboard {
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
  /** 日趋势（按日期升序） */
  daily: SimDailyPoint[];
  /** 按总曝光降序的 Top 内容 */
  topContents: SimTopContent[];
  /** 曝光环比异常日（按日期升序） */
  anomalies: SimAnomalyDay[];
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** 纯计算：行集 → 看板（不碰 repo，便于测试与复用；disclaimer 默认模拟声明，真实数据看板传入真实声明） */
export function buildSimDashboard(
  rows: SimContentStatRow[],
  authorId: string,
  opts?: { disclaimer?: string },
): SimDashboard {
  const sorted = [...rows].sort((a, b) => a.statDate.localeCompare(b.statDate));
  const videoIds = new Set(sorted.map((r) => r.videoId));

  // —— 账号层总量 ——
  const sum = (pick: (r: SimContentStatRow) => number): number => sorted.reduce((s, r) => s + pick(r), 0);
  const totalShow = sum((r) => r.showCnt);
  const totalPlay = sum((r) => r.playCnt);
  const totalComplete = sum((r) => r.completePlayCnt);
  const totalLike = sum((r) => r.likeCnt);
  const totalComment = sum((r) => r.commentCnt);
  const totalShare = sum((r) => r.shareCnt);
  const totalFollow = sum((r) => r.followCnt);
  const totalInteraction = totalLike + totalComment + totalShare;

  // —— 日趋势（按日期分组）——
  const byDate = new Map<string, SimContentStatRow[]>();
  for (const r of sorted) {
    const list = byDate.get(r.statDate) ?? [];
    list.push(r);
    byDate.set(r.statDate, list);
  }
  const daily: SimDailyPoint[] = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, dayRows]) => {
      const s = (pick: (r: SimContentStatRow) => number): number => dayRows.reduce((acc, r) => acc + pick(r), 0);
      const dayShow = s((r) => r.showCnt);
      const dayPlay = s((r) => r.playCnt);
      const dayComplete = s((r) => r.completePlayCnt);
      const dayInteraction = s((r) => r.likeCnt) + s((r) => r.commentCnt) + s((r) => r.shareCnt);
      return {
        date,
        showCnt: dayShow,
        playCnt: dayPlay,
        completeRate: rate(dayComplete, dayPlay),
        interactionRate: rate(dayInteraction, dayPlay),
        followCnt: s((r) => r.followCnt),
      };
    });

  // —— Top 内容（按总曝光降序）——
  const byVideo = new Map<string, SimContentStatRow[]>();
  for (const r of sorted) {
    const list = byVideo.get(r.videoId) ?? [];
    list.push(r);
    byVideo.set(r.videoId, list);
  }
  const topContents: SimTopContent[] = [...byVideo.entries()]
    .map(([videoId, vRows]) => {
      const s = (pick: (r: SimContentStatRow) => number): number => vRows.reduce((acc, r) => acc + pick(r), 0);
      const vShow = s((r) => r.showCnt);
      const vPlay = s((r) => r.playCnt);
      return {
        videoId,
        caption: vRows.find((r) => r.caption != null)?.caption ?? null,
        category: vRows.find((r) => r.category != null)?.category ?? null,
        uploadDt: vRows.find((r) => r.uploadDt != null)?.uploadDt ?? null,
        showCnt: vShow,
        playCnt: vPlay,
        completeRate: rate(s((r) => r.completePlayCnt), vPlay),
        likeCnt: s((r) => r.likeCnt),
      };
    })
    .sort((a, b) => b.showCnt - a.showCnt || a.videoId.localeCompare(b.videoId))
    .slice(0, TOP_CONTENT_LIMIT);

  // —— 曝光环比异常日（首日无环比，不参与）——
  const anomalies: SimAnomalyDay[] = [];
  for (let i = 1; i < daily.length; i += 1) {
    const prev = daily[i - 1]!;
    const cur = daily[i]!;
    if (prev.showCnt < MIN_SHOW_BASELINE) continue; // 降噪：小基数前日无判定意义（12→18 也标 +50% 是噪声）
    const changePct = (cur.showCnt - prev.showCnt) / prev.showCnt;
    if (Math.abs(changePct) >= ANOMALY_THRESHOLD) {
      anomalies.push({
        date: cur.date,
        previousShow: prev.showCnt,
        showCnt: cur.showCnt,
        changePct,
        direction: changePct > 0 ? 'up' : 'down',
      });
    }
  }

  return {
    disclaimer: opts?.disclaimer ?? SIM_DISCLAIMER,
    authorId,
    dateFrom: sorted[0]?.statDate ?? '',
    dateTo: sorted[sorted.length - 1]?.statDate ?? '',
    videoCount: videoIds.size,
    totals: {
      showCnt: totalShow,
      playCnt: totalPlay,
      completeRate: rate(totalComplete, totalPlay),
      interactionRate: rate(totalInteraction, totalPlay),
      likeCnt: totalLike,
      commentCnt: totalComment,
      shareCnt: totalShare,
      followCnt: totalFollow,
    },
    daily,
    topContents,
    anomalies,
  };
}

export interface SimDashboardOptions {
  repo: Repo;
  /** 指定账号（作者 id）；缺省取总曝光第一的头部账号 */
  authorId?: string;
}

export interface SimDashboardResult {
  dashboard: SimDashboard;
  /** 账号一览（--author 缺省时帮助用户挑下一个账号看） */
  topAuthors: Array<{ authorId: string; totalShow: number; videoCount: number }>;
}

export async function runSimDashboard(opts: SimDashboardOptions): Promise<SimDashboardResult> {
  const topAuthors = await opts.repo.listSimAuthors('kuairec', 10);
  let authorId = opts.authorId;
  if (authorId == null) {
    if (topAuthors.length === 0) throw new Error('模拟数据还是空的，先执行 gwd sim-import');
    authorId = topAuthors[0]!.authorId;
  }
  const rows = await opts.repo.getSimStatsByAuthor('kuairec', authorId);
  if (rows.length === 0) {
    throw new Error(`账号 ${authorId} 没有模拟数据（可用账号见 gwd sim-dashboard 输出的头部账号列表）`);
  }
  return {
    dashboard: buildSimDashboard(rows, authorId),
    topAuthors: topAuthors.map((a) => ({ authorId: a.authorId, totalShow: a.totalShow, videoCount: a.videoCount })),
  };
}
