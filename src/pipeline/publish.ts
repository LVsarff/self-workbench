/**
 * 发布台账服务（模块③ B2）：confirmed 内容 → 待发布队列 → 人工发布 → 回填台账。
 *
 * 边界（门④ 红线）：发布动作永远人工，本模块零 LLM、零平台对接——
 * 只做记录与提醒（队列 / 建议时段 / 超 24h 警示），是 V3 归因的事实表。
 *
 * 语义：
 *   - sync 幂等：以草稿 status='confirmed' 为准（「确认后又弃用」的不会入队），
 *     已有 draft_id 记录的跳过；草稿 discard 重做后 id 不变，pending 行自动指向最新确认版
 *   - list 只展示草稿当前 status='confirmed' 的记录（防误发布已废弃内容的存量 pending）
 *   - record 回填幂等拒绝：一条记录只回填一次（链接/时间填错属人工修正场景，暂不支持覆盖）
 */
import type { ContentDraftRow, PublishRecordRow, Repo } from '../db/repo.js';
import type { Platform } from '../core/types.js';
import { nextPublishSlot, shanghaiSlotToIso, suggestSlots } from '../core/publish-slots.js';
import { parseVideoId } from '../core/video-id.js';
import { todayShanghai } from '../util.js';

/** pending 超 24h 未发布视为超时（提醒层，不阻塞不惩罚） */
export const PUBLISH_OVERDUE_MS = 24 * 60 * 60 * 1000;

export { nextPublishSlot, suggestSlots };

export interface SyncPublishOptions {
  repo: Repo;
  date?: string;
  /** 注入时钟（测试用；默认现在） */
  now?: Date;
}

export interface SyncPublishResult {
  date: string;
  created: number;
  skipped: number;
}

/** 待发布队列同步：门③ confirmed 草稿 → pending 记录（幂等，可随时重跑补漏） */
export async function syncPublishQueue(opts: SyncPublishOptions): Promise<SyncPublishResult> {
  const date = opts.date ?? todayShanghai();
  const now = opts.now ?? new Date();
  const drafts = await opts.repo.getContentDrafts(date);
  const confirmed = drafts.filter((d) => d.status === 'confirmed');
  const existing = await opts.repo.getPublishRecords(date);
  const existingDraftIds = new Set(existing.map((r) => r.draftId));

  let created = 0;
  let skipped = 0;
  for (const d of confirmed) {
    if (existingDraftIds.has(d.id)) {
      skipped += 1;
      continue;
    }
    await opts.repo.createPublishRecord({
      draftId: d.id,
      runId: d.runId,
      batchDate: d.batchDate,
      productId: d.productId,
      platform: d.platform,
      plannedAt: shanghaiSlotToIso(nextPublishSlot(d.platform, now)),
    });
    created += 1;
  }
  return { date, created, skipped };
}

export interface PublishQueueItem {
  record: PublishRecordRow;
  draft: ContentDraftRow;
  /** pending 且距入队超 24h（提醒层） */
  overdue: boolean;
  /** 该平台的建议发布时段（展示用） */
  suggestedSlots: string[];
}

export interface ListPublishOptions {
  repo: Repo;
  date?: string;
  now?: Date;
}

/** 待发布队列 + 已发布台账视图（pending 在前；草稿非 confirmed 的记录不显示） */
export async function listPublishQueue(opts: ListPublishOptions): Promise<PublishQueueItem[]> {
  const date = opts.date ?? todayShanghai();
  const now = opts.now ?? new Date();
  const records = await opts.repo.getPublishRecords(date);
  const drafts = await opts.repo.getContentDrafts(date);
  const draftById = new Map(drafts.map((d) => [d.id, d]));

  const items: PublishQueueItem[] = [];
  for (const r of records) {
    const draft = draftById.get(r.draftId);
    if (!draft) continue; // 防御：记录指向的草稿不在当日（正常流程不发生）
    if (draft.status !== 'confirmed') continue; // 已弃用/重做中的存量 pending 不展示，防误发布
    items.push({
      record: r,
      draft,
      overdue: r.status === 'pending' && now.getTime() - new Date(r.createdAt).getTime() > PUBLISH_OVERDUE_MS,
      suggestedSlots: suggestSlots(r.platform, now),
    });
  }
  items.sort((a, b) => {
    if (a.record.status !== b.record.status) return a.record.status === 'pending' ? -1 : 1;
    return a.draft.externalId.localeCompare(b.draft.externalId) || a.record.platform.localeCompare(b.record.platform);
  });
  return items;
}

export interface RecordPublishOptions {
  repo: Repo;
  date?: string;
  externalId: string;
  platform: Platform;
  url: string;
  /** 实际发布时间（ISO 格式字符串；默认现在） */
  publishedAt?: string;
  /** 是否已在平台勾选「AI 生成」标注（默认 false，如实回填） */
  aiLabeled?: boolean;
  /** 平台侧内容标识（视频/笔记 id；模块⑤ 归因 join 锚点，回填时顺手带上，漏了可 gwd attribution-link 补链） */
  videoId?: string;
  now?: Date;
}

export interface RecordPublishResult {
  date: string;
  externalId: string;
  platform: Platform;
  record: PublishRecordRow;
}

/** 人工发布后回填台账：pending → published（链接 / 时间 / AI 标注）。 */
export async function recordPublish(opts: RecordPublishOptions): Promise<RecordPublishResult> {
  const date = opts.date ?? todayShanghai();
  const url = opts.url.trim();
  if (url.length === 0) throw new Error('笔记链接不能为空');
  if (url.length > 500) throw new Error(`笔记链接过长（${url.length} 字符，上限 500）`);
  // 台账是未来 Web/复盘页的渲染数据源（<a href>），协议与控制字符在入口拦住：
  // javascript:/data: 等伪协议 = 存储型 XSS 隐患；换行/制表 = 多行注入载荷
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`笔记链接须以 http:// 或 https:// 开头（收到: "${url.slice(0, 50)}"）`);
  }
  if (/[\x00-\x1f\x7f]/.test(url)) throw new Error('笔记链接不能包含换行/控制字符');

  // 归因锚点白名单校验（入口拦住，不回显原值）
  let videoId: string | null = null;
  if (opts.videoId !== undefined && opts.videoId !== '') {
    const parsed = parseVideoId(opts.videoId);
    if (!parsed.ok) throw new Error(parsed.error);
    videoId = parsed.value;
  }

  let publishedAt: string;
  if (opts.publishedAt !== undefined && opts.publishedAt !== '') {
    // 双层校验：先卡 ISO 日期前缀（防 V8 对 '2026-2-30' 这类宽松串按本地时区滚动解析），
    // 再用 new Date 验证分量合法（'2026-13-45T…' → Invalid）
    if (!/^\d{4}-\d{2}-\d{2}([T]|$)/.test(opts.publishedAt)) {
      throw new Error(`发布时间格式无效: "${opts.publishedAt}"（需 ISO 格式，如 2026-01-05T21:00:00+08:00）`);
    }
    const t = new Date(opts.publishedAt);
    if (Number.isNaN(t.getTime())) {
      throw new Error(`发布时间格式无效: "${opts.publishedAt}"（需 ISO 格式，如 2026-01-05T21:00:00+08:00）`);
    }
    publishedAt = t.toISOString();
  } else {
    publishedAt = (opts.now ?? new Date()).toISOString();
  }

  const drafts = await opts.repo.getContentDrafts(date);
  const draft = drafts.find((d) => d.externalId === opts.externalId && d.platform === opts.platform);
  if (!draft) {
    const owned = drafts.filter((d) => d.externalId === opts.externalId).map((d) => d.platform);
    throw new Error(`${date} 没有找到 ${opts.externalId} 的${opts.platform === 'xiaohongshu' ? '小红书' : '抖音'}草稿${owned.length > 0 ? `（该商品已有平台: ${owned.join('、')}）` : '（先 gwd content-gen + confirm）'}`);
  }
  if (draft.status !== 'confirmed') {
    throw new Error(`${opts.externalId} 草稿当前状态为 ${draft.status}，仅门③ 已确认内容可回填发布`);
  }

  const records = await opts.repo.getPublishRecords(date);
  const record = records.find((r) => r.draftId === draft.id);
  if (!record) throw new Error(`${opts.externalId} 没有待发布记录（先执行 gwd publish-sync）`);

  await opts.repo.recordPublish(record.id, { url, publishedAt, aiLabeled: opts.aiLabeled ?? false, videoId });
  return {
    date,
    externalId: opts.externalId,
    platform: opts.platform,
    record: { ...record, status: 'published', url, publishedAt, aiLabeled: opts.aiLabeled ?? false, videoId },
  };
}
