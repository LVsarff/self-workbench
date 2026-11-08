/**
 * 异常信号识别完整版（模块④ V3：断更 / 掉粉 / 退款异常；零 LLM）。
 * 输入「账号-内容-日」粒度表现行（与 dashboard 同源），输出账号级信号列表。
 *
 * 口径（初始经验值，参数未验证）：
 *   - 断更：数据末日距最近内容发布日 ≥3 天 → 提示，≥7 天 → 警示
 *     （发布日取 upload_dt 前缀 YYYY-MM-DD；缺失的行跳过——数据缺失不编数）
 *   - 掉粉：日净涨粉（当日 follow_cnt 合计）< 0 记掉粉日；|净掉粉| ≥100 → 警示，否则 → 提示
 *   - 退款异常：product_performance 无退款字段（真实后台导出口径未确认）——
 *     按方案 A 显式标「数据缺失 · 待后台导出补充」，不静默跳过、不造数
 * 红线：信号 detail 全部由代码从数字合成（外部可控文本不拼接进 detail）；
 * 模拟与真实数据 source 强制隔离（调用方传 source，输出方带数据源声明）。
 */
import type { SimContentStatRow } from '../db/repo.js';
import { parseIsoDate } from '../core/text-clean.js';

/** 断更提示阈值（天）：数据末日距最近发布日 ≥3 天 */
export const STALE_UPLOAD_HINT_DAYS = 3;
/** 断更警示阈值（天） */
export const STALE_UPLOAD_WARN_DAYS = 7;
/** 掉粉警示阈值（人）：单日净掉粉绝对值 ≥100 */
export const DEFAN_WARN_THRESHOLD = 100;

export type AnomalySignalType = '断更' | '掉粉' | '退款异常';
export type AnomalySignalLevel = '提示' | '警示';

export interface AnomalySignal {
  type: AnomalySignalType;
  level: AnomalySignalLevel;
  /** 触发日（掉粉 = 当日；断更 = 数据末日） */
  date: string;
  /** 由代码从数字合成，不含外部可控自由文本 */
  detail: string;
}

export interface AnomalySignalsResult {
  authorId: string;
  dateFrom: string;
  dateTo: string;
  signals: AnomalySignal[];
  /** 数据缺失声明（当前：退款口径） */
  dataGaps: string[];
}

/** 日期差（天）：b - a；非法日期返回 null */
function dayDiff(a: string, b: string): number | null {
  const da = Date.UTC(...(a.split('-').map(Number) as [number, number, number]));
  const db = Date.UTC(...(b.split('-').map(Number) as [number, number, number]));
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

/** upload_dt 前缀取日（容忍 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DD'）；非法 → null */
function uploadDay(uploadDt: string | null): string | null {
  if (uploadDt == null) return null;
  return parseIsoDate(uploadDt.slice(0, 10));
}

export function buildAnomalySignals(rows: SimContentStatRow[], authorId: string): AnomalySignalsResult {
  const sorted = [...rows].sort((a, b) => a.statDate.localeCompare(b.statDate));
  const dates = sorted.map((r) => r.statDate);
  const dateFrom = dates[0] ?? '';
  const dateTo = dates[dates.length - 1] ?? '';

  const signals: AnomalySignal[] = [];

  // —— 掉粉：按日聚合净涨粉 ——
  const netByDate = new Map<string, number>();
  for (const r of sorted) {
    netByDate.set(r.statDate, (netByDate.get(r.statDate) ?? 0) + r.followCnt);
  }
  for (const [date, net] of netByDate) {
    if (net >= 0) continue;
    const loss = Math.abs(net);
    const level: AnomalySignalLevel = loss >= DEFAN_WARN_THRESHOLD ? '警示' : '提示';
    signals.push({ type: '掉粉', level, date, detail: `日净涨粉 ${net}（掉粉 ${loss} 人）` });
  }

  // —— 断更：数据末日距最近发布日 ——
  const uploadDays = sorted.map((r) => uploadDay(r.uploadDt)).filter((d): d is string => d != null);
  if (uploadDays.length > 0 && dateTo !== '') {
    const latestUpload = uploadDays.reduce((m, d) => (d > m ? d : m), uploadDays[0]!);
    const gap = dayDiff(latestUpload, dateTo);
    if (gap != null && gap >= STALE_UPLOAD_HINT_DAYS) {
      const level: AnomalySignalLevel = gap >= STALE_UPLOAD_WARN_DAYS ? '警示' : '提示';
      signals.push({
        type: '断更',
        level,
        date: dateTo,
        detail: `数据末日 ${dateTo} 距最近发布 ${latestUpload} 已 ${gap} 天无新内容`,
      });
    }
  }

  // 排序：警示在前，同级别按类型日期
  signals.sort((a, b) => {
    if (a.level !== b.level) return a.level === '警示' ? -1 : 1;
    return a.date.localeCompare(b.date) || a.type.localeCompare(b.type);
  });

  return {
    authorId,
    dateFrom,
    dateTo,
    signals,
    // 方案 A：退款字段缺失显式声明（product_performance 无退款列，真实后台导出口径未确认）
    dataGaps: ['退款异常 · 数据缺失（product_performance 无退款字段，待后台导出口径确认后补列）'],
  };
}
