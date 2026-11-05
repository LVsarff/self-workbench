/**
 * 真实数据账号看板（P0：真实账号数据通道，零 LLM）。
 * 复用 buildSimDashboard 的纯计算（日趋势 / Top 内容 / 异常日口径完全一致），
 * 差异仅在读源（source='manual'）与声明（真实数据声明，非模拟声明）。
 *
 * 红线：只读 source='manual'，与模拟数据（'kuairec'）永不混读；输出必须带 REAL_DISCLAIMER。
 * 局限：真实数据无归因链路（无内容↔商品↔成交），复盘结论仅到内容表现层。
 */
import type { Repo } from '../db/repo.js';
import { buildSimDashboard, type SimDashboard } from './sim-dashboard.js';

/** 真实数据看板必带声明 */
export const REAL_DISCLAIMER =
  '真实数据 · 本人账号手工导入（source=manual，抖音创作者后台口径；无归因链路，结论仅到内容表现层）';

export interface RealDashboardOptions {
  repo: Repo;
  /** 指定账号；缺省取总曝光第一的账号 */
  authorId?: string;
}

export interface RealDashboardResult {
  dashboard: SimDashboard;
  topAuthors: Array<{ authorId: string; totalShow: number; videoCount: number }>;
}

export async function runRealDashboard(opts: RealDashboardOptions): Promise<RealDashboardResult> {
  const topAuthors = await opts.repo.listSimAuthors('manual', 10);
  let authorId = opts.authorId;
  if (authorId == null) {
    if (topAuthors.length === 0) throw new Error('真实数据还是空的，先执行 gwd real-import <csv>');
    authorId = topAuthors[0]!.authorId;
  }
  const rows = await opts.repo.getSimStatsByAuthor('manual', authorId);
  if (rows.length === 0) {
    throw new Error(`账号 ${authorId} 没有真实数据（注意：模拟数据账号在这里看不到，两套数据按 source 隔离）`);
  }
  return {
    dashboard: buildSimDashboard(rows, authorId, { disclaimer: REAL_DISCLAIMER }),
    topAuthors: topAuthors.map((a) => ({ authorId: a.authorId, totalShow: a.totalShow, videoCount: a.videoCount })),
  };
}
