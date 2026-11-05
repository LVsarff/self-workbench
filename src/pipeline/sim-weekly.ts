/**
 * 模拟数据周复盘报告（模块④ B3 第三批：数据打通层，零 LLM）。
 * 把 sim_content_stats（账号-内容-日粒度）按「滚动 7 天窗口」组织成周报：
 *   - 本周 vs 上周环比（曝光/播放/完播率/互动率/涨粉）
 *   - 本周日趋势 + 曝光环比异常日（复用 sim-dashboard 的降噪口径）
 *   - Top 内容（按曝光）/ Bottom 内容（有量但完播率垫底）
 *   - 下周建议：纯启发式规则触发（非 LLM），每条标注触发依据
 *
 * 窗口定义：以 weekEnd（含当天）为结束日，本周 = [weekEnd-6, weekEnd]，
 * 上周 = [weekEnd-13, weekEnd-7]。上周无数据时环比记 null（不编数据）。
 *
 * 红线：source 强制 'kuairec'，输出必带 SIM_DISCLAIMER。
 */
import type { Repo, SimContentStatRow } from '../db/repo.js';
import { buildSimDashboard, SIM_DISCLAIMER } from './sim-dashboard.js';

/** Bottom 内容参与门槛：本周曝光 ≥ 该值才评价完播率（避免小基数误判） */
export const BOTTOM_MIN_SHOW = 1000;
/** Bottom 内容展示数量 */
export const BOTTOM_LIMIT = 3;

/** YYYY-MM-DD 加减天数（UTC 算术，返回 YYYY-MM-DD） */
export function dateAdd(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  t.setUTCDate(t.getUTCDate() + days);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export interface SimWeekTotals {
  showCnt: number;
  playCnt: number;
  /** complete_play / play（play=0 记 0） */
  completeRate: number;
  interactionRate: number;
  likeCnt: number;
  commentCnt: number;
  shareCnt: number;
  followCnt: number;
  videoCount: number;
}

export interface SimWeekComparison {
  /** 上周（无数据时 null，环比同步 null） */
  previous: SimWeekTotals | null;
  current: SimWeekTotals;
  /** (本周-上周)/上周；上周为 0 或缺失时 null（分母为 0 无意义） */
  changes: {
    showCnt: number | null;
    playCnt: number | null;
    /** 百分点点差（本周-上周），比率型指标用 pp 不用 % */
    completeRatePp: number | null;
    interactionRatePp: number | null;
    followCnt: number | null;
  };
}

export interface SimWeeklyContent {
  videoId: string;
  caption: string | null;
  category: string | null;
  showCnt: number;
  playCnt: number;
  completeRate: number;
  likeCnt: number;
  followCnt: number;
}

/** 规则触发的建议（非 LLM；trigger 标注触发条件，人判采纳） */
export interface SimWeeklySuggestion {
  rule: string;
  trigger: string;
  text: string;
}

export interface SimWeeklyReport {
  disclaimer: string;
  authorId: string;
  /** 本周窗口 [dateFrom, dateTo]（实际有数据的范围，可能不足 7 天） */
  currentWeek: { dateFrom: string; dateTo: string };
  /** 上周窗口（实际有数据的范围；无数据为 null） */
  previousWeek: { dateFrom: string; dateTo: string } | null;
  comparison: SimWeekComparison;
  /** 本周日趋势（来自 sim-dashboard 的日聚合） */
  daily: ReturnType<typeof buildSimDashboard>['daily'];
  /** 本周曝光环比异常日（已降噪：前日曝光 ≥ 1 万） */
  anomalies: ReturnType<typeof buildSimDashboard>['anomalies'];
  topContents: SimWeeklyContent[];
  /** 有量但完播率垫底的内容（曝光 ≥ BOTTOM_MIN_SHOW 才参评） */
  bottomContents: SimWeeklyContent[];
  suggestions: SimWeeklySuggestion[];
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function weekTotals(rows: SimContentStatRow[]): SimWeekTotals {
  const sum = (pick: (r: SimContentStatRow) => number): number => rows.reduce((s, r) => s + pick(r), 0);
  const show = sum((r) => r.showCnt);
  const play = sum((r) => r.playCnt);
  const complete = sum((r) => r.completePlayCnt);
  const interaction = sum((r) => r.likeCnt) + sum((r) => r.commentCnt) + sum((r) => r.shareCnt);
  return {
    showCnt: show,
    playCnt: play,
    completeRate: rate(complete, play),
    interactionRate: rate(interaction, play),
    likeCnt: sum((r) => r.likeCnt),
    commentCnt: sum((r) => r.commentCnt),
    shareCnt: sum((r) => r.shareCnt),
    followCnt: sum((r) => r.followCnt),
    videoCount: new Set(rows.map((r) => r.videoId)).size,
  };
}

/** 按内容聚合本周行 → SimWeeklyContent（按曝光降序） */
function aggregateByVideo(rows: SimContentStatRow[]): SimWeeklyContent[] {
  const byVideo = new Map<string, SimContentStatRow[]>();
  for (const r of rows) {
    const list = byVideo.get(r.videoId) ?? [];
    list.push(r);
    byVideo.set(r.videoId, list);
  }
  return [...byVideo.entries()]
    .map(([videoId, vRows]) => {
      const s = (pick: (r: SimContentStatRow) => number): number => vRows.reduce((acc, r) => acc + pick(r), 0);
      const show = s((r) => r.showCnt);
      const play = s((r) => r.playCnt);
      return {
        videoId,
        caption: vRows.find((r) => r.caption != null)?.caption ?? null,
        category: vRows.find((r) => r.category != null)?.category ?? null,
        showCnt: show,
        playCnt: play,
        completeRate: rate(s((r) => r.completePlayCnt), play),
        likeCnt: s((r) => r.likeCnt),
        followCnt: s((r) => r.followCnt),
      };
    })
    .sort((a, b) => b.showCnt - a.showCnt || a.videoId.localeCompare(b.videoId));
}

/** 启发式建议（纯规则触发；改动阈值时同步更新注释） */
function buildSuggestions(
  comparison: SimWeekComparison,
  topContents: SimWeeklyContent[],
  bottomContents: SimWeeklyContent[],
): SimWeeklySuggestion[] {
  const out: SimWeeklySuggestion[] = [];
  const { previous, current } = comparison;

  if (comparison.changes.showCnt != null && comparison.changes.showCnt <= -0.3) {
    out.push({
      rule: '曝光环比跌 ≥ 30%',
      trigger: `曝光 ${previous!.showCnt.toLocaleString()} → ${current.showCnt.toLocaleString()}（${(comparison.changes.showCnt * 100).toFixed(1)}%）`,
      text: '曝光下滑明显：检查本周发布频率与题材是否变化，对比上周 Top 内容找差异。',
    });
  }
  if (comparison.changes.completeRatePp != null && comparison.changes.completeRatePp <= -0.05) {
    out.push({
      rule: '完播率下滑 ≥ 5pp',
      trigger: `完播率 ${(previous!.completeRate * 100).toFixed(1)}% → ${(current.completeRate * 100).toFixed(1)}%`,
      text: '完播率下滑：优先检查视频开头（黄金 3 秒）与时长；Bottom 内容是具体病灶。',
    });
  }
  if (current.videoCount >= 2 && current.followCnt > 0 && topContents.length > 0 && topContents[0]!.followCnt / current.followCnt >= 0.5) {
    const top = topContents[0]!;
    out.push({
      rule: '涨粉集中单一内容 ≥ 50%',
      trigger: `内容 [${top.videoId}] 贡献 ${(top.followCnt / current.followCnt * 100).toFixed(0)}% 涨粉`,
      text: '涨粉集中在单一内容（本周 ≥ 2 条内容时才评价）：考虑围绕该题材做系列化，复制有效要素。',
    });
  }
  if (bottomContents.length > 0 && bottomContents[0]!.completeRate < current.completeRate * 0.5) {
    const worst = bottomContents[0]!;
    out.push({
      rule: '有量内容完播率 < 账号一半',
      trigger: `内容 [${worst.videoId}] 曝光 ${worst.showCnt.toLocaleString()} 但完播率 ${(worst.completeRate * 100).toFixed(1)}%`,
      text: '曝光给了但留不住人：该内容题材/开头与账号主力观众可能不匹配，复盘后决定舍弃或改造。',
    });
  }
  if (out.length === 0) {
    out.push({
      rule: '无规则触发',
      trigger: '各项指标平稳，无异常日或明显下滑',
      text: '本周各项平稳：按既定节奏发布，持续观察。建议由人判断是否有人工观察到的信号未进数据。',
    });
  }
  return out;
}

/** 纯计算：账号全量行 + 周结束日 → 周报（不碰 repo，便于测试与复用） */
export function buildSimWeeklyReport(rows: SimContentStatRow[], authorId: string, weekEnd: string): SimWeeklyReport {
  const curFrom = dateAdd(weekEnd, -6);
  const prevFrom = dateAdd(weekEnd, -13);
  const prevTo = dateAdd(weekEnd, -7);

  const currentRows = rows.filter((r) => inRange(r.statDate, curFrom, weekEnd));
  const previousRows = rows.filter((r) => inRange(r.statDate, prevFrom, prevTo));
  if (currentRows.length === 0) {
    throw new Error(`账号 ${authorId} 在 ${curFrom} ~ ${weekEnd} 无模拟数据（换 --date 指定周期内某天）`);
  }

  const current = weekTotals(currentRows);
  const previous = previousRows.length > 0 ? weekTotals(previousRows) : null;
  const pct = (cur: number, prev: number): number | null => (prev > 0 ? (cur - prev) / prev : null);
  const comparison: SimWeekComparison = {
    previous,
    current,
    changes: {
      showCnt: previous ? pct(current.showCnt, previous.showCnt) : null,
      playCnt: previous ? pct(current.playCnt, previous.playCnt) : null,
      completeRatePp: previous ? current.completeRate - previous.completeRate : null,
      interactionRatePp: previous ? current.interactionRate - previous.interactionRate : null,
      followCnt: previous ? pct(current.followCnt, previous.followCnt) : null,
    },
  };

  // 复用看板的日聚合与异常日（降噪口径一致：前日曝光 ≥ MIN_SHOW_BASELINE）。
  // 用全量行构建再过滤本周：保留「本周首日 vs 上周末」的跨周环比，不丢首日信号。
  const dashboard = buildSimDashboard(rows, authorId);
  const daily = dashboard.daily.filter((p) => inRange(p.date, curFrom, weekEnd));

  const weeklyContents = aggregateByVideo(currentRows);
  const topContents = weeklyContents.slice(0, 5);
  const bottomContents = weeklyContents
    .filter((c) => c.showCnt >= BOTTOM_MIN_SHOW)
    .sort((a, b) => a.completeRate - b.completeRate || b.showCnt - a.showCnt)
    .slice(0, BOTTOM_LIMIT);

  const curDates = currentRows.map((r) => r.statDate).sort();
  const prevDates = previousRows.map((r) => r.statDate).sort();

  return {
    disclaimer: SIM_DISCLAIMER,
    authorId,
    currentWeek: { dateFrom: curDates[0]!, dateTo: curDates[curDates.length - 1]! },
    previousWeek: previous ? { dateFrom: prevDates[0]!, dateTo: prevDates[prevDates.length - 1]! } : null,
    comparison,
    daily,
    anomalies: dashboard.anomalies.filter((a) => inRange(a.date, curFrom, weekEnd)),
    topContents,
    bottomContents,
    suggestions: buildSuggestions(comparison, topContents, bottomContents),
  };
}

export interface SimWeeklyOptions {
  repo: Repo;
  /** 账号（作者 id）；缺省取总曝光第一的头部账号 */
  authorId?: string;
  /** 周结束日 YYYY-MM-DD（含当天）；缺省取该账号最后有数据的日期 */
  weekEnd?: string;
}

export async function runSimWeekly(opts: SimWeeklyOptions): Promise<SimWeeklyReport> {
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
  const weekEnd = opts.weekEnd ?? rows.reduce((max, r) => (r.statDate > max ? r.statDate : max), rows[0]!.statDate);
  return buildSimWeeklyReport(rows, authorId, weekEnd);
}
