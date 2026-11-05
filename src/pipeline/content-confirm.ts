/**
 * 确认门（门③）：内容发布的合规最后关口（《场景拆解》2.2 五道门之一，2.1 #12）。
 * - 5 项清单（《场景拆解》5 决策点 3）逐项人工确认，任一项未确认 → 拒绝
 * - banned_hits 非空 = 硬拦截（词表层的门侧执行；正常流程修不掉早已转 needs_manual，此处为纵深防御）
 * - L2 审查提示（review.risks）不拦截——人工在清单第 2 项里终判
 * - 决策 append-only 落 content_decisions（5 项勾选留痕）；草稿状态机 draft → confirmed / discarded
 */
import { PLATFORM_LABEL, type Platform } from '../core/types.js';
import type { ContentDraftRow, Repo } from '../db/repo.js';
import { todayShanghai } from '../util.js';

/** 5 项确认清单（顺序固定，answers 按此序对应） */
export const GATE3_CHECKLIST: readonly string[] = [
  '卖点属实：文中价格/销量/好评率与商品页一致，无编造',
  '无极限词、无夸大宣传（词表命中与审查提示均已处理）',
  '符合账号人设：语气与内容方向不越界',
  '钩子有效：标题/前 3 秒能留住目标人群',
  '发布时将勾选平台「AI 生成」标注',
];

/** 备注入流水前的上限（CLI --note 是自由文本，防极端载荷撑爆决策表） */
const NOTE_MAX = 500;
const NOTE_CLIP_MARK = '…[截断]';

function clipNote(note: string | undefined): string | null {
  if (note == null || note.length === 0) return null;
  return note.length <= NOTE_MAX ? note : note.slice(0, NOTE_MAX - NOTE_CLIP_MARK.length) + NOTE_CLIP_MARK;
}

export interface ConfirmContentOptions {
  repo: Repo;
  date?: string;
  externalId: string;
  platform: Platform;
  /** 5 项清单逐项回答（顺序同 GATE3_CHECKLIST），全部 true 才放行 */
  answers: boolean[];
  note?: string;
}

export interface DiscardContentOptions {
  repo: Repo;
  date?: string;
  externalId: string;
  platform: Platform;
  note?: string;
}

export interface ContentGateResult {
  date: string;
  runId: string;
  externalId: string;
  platform: Platform;
}

async function findDraft(repo: Repo, date: string, externalId: string, platform: Platform): Promise<ContentDraftRow> {
  const drafts = await repo.getContentDrafts(date);
  const draft = drafts.find((d) => d.externalId === externalId && d.platform === platform);
  if (!draft) {
    const platforms = drafts.filter((d) => d.externalId === externalId).map((d) => PLATFORM_LABEL[d.platform]);
    throw new Error(
      `${date} 没有找到 ${externalId} 的${PLATFORM_LABEL[platform]}草稿${platforms.length > 0 ? `（该商品已有: ${platforms.join('、')}）` : '（可用草稿见 gwd contents）'}`,
    );
  }
  return draft;
}

export async function confirmContentDraft(opts: ConfirmContentOptions): Promise<ContentGateResult> {
  const date = opts.date ?? todayShanghai();

  if (opts.answers.length !== GATE3_CHECKLIST.length) {
    throw new Error(`门③ 需逐项回答 ${GATE3_CHECKLIST.length} 项清单（收到 ${opts.answers.length} 项）`);
  }
  const failedItems = GATE3_CHECKLIST.filter((_, i) => opts.answers[i] !== true);
  if (failedItems.length > 0) {
    throw new Error(`以下清单项未确认，不能通过门③: ${failedItems.join('；')}`);
  }

  const draft = await findDraft(opts.repo, date, opts.externalId, opts.platform);
  if (draft.status === 'confirmed') throw new Error('该草稿已确认过（幂等拦截）');
  if (draft.status === 'discarded') throw new Error('该草稿已废弃；如需重做请 gwd content-gen --force');
  if (draft.status === 'needs_manual') {
    throw new Error('该草稿内容为空（需人工撰写/重新生成），不能确认；请先 gwd content-gen --force');
  }
  if (draft.bannedHits.length > 0) {
    throw new Error(`词表命中（硬拦截）: ${draft.bannedHits.join('、')} —— 请先 gwd content-gen --force 重新生成`);
  }

  // 状态推进 + 决策流水原子落库（PgRepo 单事务；note 截断防极端载荷）
  await opts.repo.applyContentDecision({
    draftId: draft.id,
    runId: draft.runId,
    batchDate: draft.batchDate,
    productId: draft.productId,
    platform: opts.platform,
    action: 'confirmed',
    checklist: GATE3_CHECKLIST.map((item, i) => ({ item, pass: opts.answers[i] === true })),
    note: clipNote(opts.note),
    decidedBy: 'human',
  });

  return { date, runId: draft.runId, externalId: opts.externalId, platform: opts.platform };
}

export async function discardContentDraft(opts: DiscardContentOptions): Promise<ContentGateResult> {
  const date = opts.date ?? todayShanghai();
  const draft = await findDraft(opts.repo, date, opts.externalId, opts.platform);
  if (draft.status === 'discarded') throw new Error('该草稿已废弃（幂等拦截）');

  await opts.repo.applyContentDecision({
    draftId: draft.id,
    runId: draft.runId,
    batchDate: draft.batchDate,
    productId: draft.productId,
    platform: opts.platform,
    action: 'discarded',
    checklist: null,
    note: clipNote(opts.note),
    decidedBy: 'human',
  });

  return { date, runId: draft.runId, externalId: opts.externalId, platform: opts.platform };
}
