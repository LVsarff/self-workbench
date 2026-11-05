/**
 * 数据导出（gwd export）：今日候选清单 / 发布台账 → CSV 文件。
 * - 全部文本单元格经 buildCsv 消毒（P2 修复 #3：CSV 公式注入）
 * - 只读导出，不改任何数据；标题等外部文本可能藏在库里，导出边界消毒是最后防线
 * - 内容缺失写「数据缺失」，不编数（红线同看板）
 */
import { writeFileSync } from 'node:fs';
import type { Repo } from '../db/repo.js';
import { buildCsv } from '../core/csv-export.js';
import { GRADE_LABEL } from '../core/types.js';

export const DAILY_EXPORT_COLUMNS = [
  '批次日期', '外部ID', '标题', '类目', '价格', '佣金率(%)', '近30天销量', '好评率(%)',
  '总分', '分级', '门槛通过', '完整打分', '已勾选', '推荐理由', '理由来源',
] as const;

/** 今日候选清单 → CSV 文本（空清单返回 null，CLI 层提示） */
export async function exportDailyCsv(repo: Repo, date: string): Promise<string | null> {
  const list = await repo.getDailyList(date);
  if (!list) return null;
  const rows = list.items.map((i) => [
    list.date,
    i.externalId,
    i.title,
    i.category ?? '数据缺失',
    i.price ?? '数据缺失',
    i.commissionRate ?? '数据缺失',
    i.sales30d ?? '数据缺失',
    i.reviewRate ?? '数据缺失',
    i.total,
    i.grade ? GRADE_LABEL[i.grade] : '数据缺失',
    i.gatePassed ? '是' : '否',
    i.complete ? '是' : '否',
    i.selected ? '是' : '否',
    i.reason ?? '理由待补',
    i.reasonSource ?? '无',
  ]);
  return buildCsv([...DAILY_EXPORT_COLUMNS], rows);
}

export const PUBLISH_EXPORT_COLUMNS = [
  '批次日期', '平台', '内容ID', '状态', '计划发布时间', '发布时间', '内容链接', 'AI标注',
] as const;

const PLATFORM_CN: Record<string, string> = { xiaohongshu: '小红书', douyin: '抖音' };

/** 发布台账（按批次日期）→ CSV 文本 */
export async function exportPublishCsv(repo: Repo, date: string): Promise<string | null> {
  const records = await repo.getPublishRecords(date);
  if (records.length === 0) return null;
  const rows = records.map((r) => [
    r.batchDate,
    PLATFORM_CN[r.platform] ?? r.platform,
    r.draftId,
    r.status === 'published' ? '已发布' : '待发布',
    r.plannedAt ?? '无建议',
    r.publishedAt ?? '未回填',
    r.url ?? '未回填',
    r.aiLabeled == null ? '未回填' : r.aiLabeled ? '已勾选' : '未勾选',
  ]);
  return buildCsv([...PUBLISH_EXPORT_COLUMNS], rows);
}

export interface ExportOptions {
  repo: Repo;
  /** daily | publish */
  what: 'daily' | 'publish';
  date: string;
  /** 输出文件；缺省打印到 stdout */
  out?: string;
}

export async function runExport(opts: ExportOptions): Promise<string> {
  const csv = opts.what === 'daily' ? await exportDailyCsv(opts.repo, opts.date) : await exportPublishCsv(opts.repo, opts.date);
  if (csv == null) {
    throw new Error(`${opts.date} 没有${opts.what === 'daily' ? '候选清单' : '发布台账'}记录（先跑 gwd daily-scan / gwd publish-sync）`);
  }
  if (opts.out) writeFileSync(opts.out, csv, 'utf8');
  return csv;
}
