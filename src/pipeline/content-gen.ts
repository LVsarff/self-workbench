/**
 * content-gen 流水线（模块② 内容工坊 B1）：
 *   [输入] 当日清单中已勾选的品（decisions，人拍板的）+ 近期已确认内容（历史参考）
 *   [Agent] 每品一次调用 → 小红书笔记 + 抖音脚本双版草稿
 *   [自检-修订循环]（《单Agent最小方案》§3 循环预算表：≤2 轮修订）
 *     L1 纯代码检查：结构校验 + 词表硬检查 + 历史去重 → 命中触发修订
 *       - 词表命中修不掉 / 结构始终不过 → needs_manual（硬语义：《场景拆解》2.1 #11）
 *       - 去重修不掉 → 仍是 draft，记 duplicates（提示层，门③ 终判）
 *     L2 LLM 审查（夸大/编造/残留极限词）→ 仅提示，review 字段落库，不拦截
 *   [降级] 无 key / LLM 异常 / 产出缺失 → needs_manual（人重写），绝不用模板文案补位
 * 幂等：(品, 平台) 已有 draft 且未 --force → 跳过；needs_manual → 重跑重试；
 *       confirmed 是门③ 产物，--force 也不动（重做须先 discard，让决策流水闭环）；
 *       discarded 重跑即重做（discard = 「这版不要了」，新落库的是新的一版）。
 * 审计：生成/修订（content-gen:drafts）与审查（content-gen:review）全部落 llm_call_logs。
 */
import type { ContentAgent, ContentReference, ContentRequest, ContentRevisionTask } from '../agent/content-agent.js';
import { DouyinScriptSchema, XiaohongshuNoteSchema } from '../agent/content-agent.js';
import type { ContentReviewer } from '../agent/content-reviewer.js';
import { checkBannedWords } from '../core/banned-words.js';
import { DUPLICATE_SIMILARITY_THRESHOLD, jaccardSimilarity } from '../core/similarity.js';
import type { ContentReviewRecord, DouyinScript, DuplicateHit, Platform, XiaohongshuNote } from '../core/types.js';
import type { ContentDraftInput, ContentDraftRow, Repo } from '../db/repo.js';
import { todayShanghai } from '../util.js';

export interface ContentGenOptions {
  repo: Repo;
  date?: string;
  agent?: ContentAgent | null;
  /** L2 审查器（无则跳过 L2，仅 L1 词表——有价值的降级，流水线照常完成） */
  reviewer?: ContentReviewer | null;
  /** 重新生成已有 draft 草稿（confirmed/discarded 不受影响） */
  force?: boolean;
  /** 每品最大修订轮数（默认 2，单Agent方案 §3） */
  maxRevisions?: number;
}

export interface ContentGenResult {
  date: string;
  runId: string;
  /** 勾选品数 */
  productCount: number;
  /** 本次 LLM 成功落库的草稿数 */
  generated: number;
  /** 本次标记 needs_manual 的草稿数 */
  needsManual: number;
  /** 幂等跳过的（品, 平台）数 */
  skipped: number;
  /** banned_hits 非空的草稿数 */
  bannedHitCount: number;
  /** L2 审查得出结论的草稿数（pass=true/false；跳过不计） */
  reviewed: number;
  /** 修订调用总次数（所有品合计） */
  revisions: number;
  /** duplicates 非空的草稿数 */
  duplicateHitCount: number;
  /** 该日存在任一 needs_manual 草稿 */
  degraded: boolean;
  /** 跑完后该日全部草稿 */
  drafts: ContentDraftRow[];
}

const PLATFORMS: Platform[] = ['xiaohongshu', 'douyin'];

/** 历史窗口：与最近 14 天的草稿做去重比对 / 取已确认内容做参考 */
const HISTORY_DAYS = 14;
/** 注入生成 prompt 的历史参考条数上限 */
const MAX_REFERENCES = 8;

/** 草稿全文（词表/去重检查用）：拼接该平台所有文本字段 */
export function draftText(platform: Platform, content: XiaohongshuNote | DouyinScript): string {
  if (platform === 'xiaohongshu') {
    const n = content as XiaohongshuNote;
    return [n.title, n.body, ...n.tags, n.coverIdea ?? ''].join(' ');
  }
  const s = content as DouyinScript;
  return [s.hook, ...s.points, s.cta].join(' ');
}

/** 展示标题（历史参考 / 去重提示用） */
export function draftDisplayTitle(platform: Platform, content: XiaohongshuNote | DouyinScript): string {
  return platform === 'xiaohongshu' ? (content as XiaohongshuNote).title : (content as DouyinScript).hook;
}

/** 结构校验（防 Agent 产出形状跑偏；AI 路径工具入参已过 zod，此处兜底） */
function validateDraft(platform: Platform, content: unknown): boolean {
  const parsed = platform === 'xiaohongshu' ? XiaohongshuNoteSchema.safeParse(content) : DouyinScriptSchema.safeParse(content);
  return parsed.success;
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** 单平台检查结论（一轮自检的产物） */
interface CheckOutcome {
  valid: boolean;
  bannedHits: string[];
  duplicates: DuplicateHit[];
  /** 供修订 prompt 的问题清单（空 = 该平台通过） */
  issues: string[];
}

/** 当日已定稿的草稿文本（跨品去重：同日多条内容互相撞车也算重复；含幂等跳过的存量 + 本 run 新落库的） */
interface InRunText {
  platform: Platform;
  externalId: string;
  batchDate: string;
  title: string;
  text: string;
}

function checkPlatform(
  platform: Platform,
  content: XiaohongshuNote | DouyinScript | null,
  historyRows: ContentDraftRow[],
  inRun: InRunText[],
): CheckOutcome {
  if (!content) {
    return { valid: false, bannedHits: [], duplicates: [], issues: ['该平台草稿未产出，请补齐'] };
  }
  if (!validateDraft(platform, content)) {
    return { valid: false, bannedHits: [], duplicates: [], issues: ['草稿结构不合规（长度/字段不符任务包 schema），请按结构重新生成'] };
  }
  const text = draftText(platform, content);
  const bannedHits = checkBannedWords(text);
  const duplicates: DuplicateHit[] = [];
  const candidates: Array<{ externalId: string; batchDate: string; title: string; text: string }> = [
    ...historyRows.filter((h) => h.platform === platform && h.content !== null).map((h) => ({
      externalId: h.externalId,
      batchDate: h.batchDate,
      title: draftDisplayTitle(platform, h.content!),
      text: draftText(platform, h.content!),
    })),
    ...inRun.filter((t) => t.platform === platform),
  ];
  for (const c of candidates) {
    const sim = jaccardSimilarity(text, c.text);
    if (sim >= DUPLICATE_SIMILARITY_THRESHOLD) {
      duplicates.push({ externalId: c.externalId, batchDate: c.batchDate, title: c.title, similarity: Math.round(sim * 100) / 100 });
    }
  }
  duplicates.sort((a, b) => b.similarity - a.similarity);

  const issues: string[] = [];
  if (bannedHits.length > 0) issues.push(`词表命中: ${bannedHits.join('、')} —— 必须去除这些表述`);
  for (const d of duplicates.slice(0, 3)) {
    issues.push(`与 ${d.batchDate} 的「${d.title}」相似度 ${d.similarity.toFixed(2)}，请换角度重写`);
  }
  return { valid: true, bannedHits, duplicates: duplicates.slice(0, 3), issues };
}

export async function runContentGen(opts: ContentGenOptions): Promise<ContentGenResult> {
  const date = opts.date ?? todayShanghai();
  const repo = opts.repo;
  const maxRevisions = opts.maxRevisions ?? 2;

  const list = await repo.getDailyList(date);
  if (!list) throw new Error(`${date} 没有候选清单，先执行 gwd daily-scan`);
  const selected = list.items.filter((i) => i.selected);
  if (selected.length === 0) throw new Error(`${date} 没有勾选的品，先执行 gwd select <id...>`);

  const existing = await repo.getContentDrafts(date);
  const existingMap = new Map(existing.map((d) => [`${d.productId}|${d.platform}`, d]));

  // 历史窗口（[since, date)）：去重比对池 + 已确认内容参考
  const history = await repo.getRecentContentDrafts(daysBefore(date, HISTORY_DAYS), date);
  const references: ContentReference[] = history
    .filter((h) => h.status === 'confirmed' && h.content !== null)
    .slice(0, MAX_REFERENCES)
    .map((h) => ({ platform: h.platform, batchDate: h.batchDate, title: draftDisplayTitle(h.platform, h.content!) }));

  const agent = opts.agent ?? null;
  const reviewer = opts.reviewer ?? null;

  const toSave: ContentDraftInput[] = [];
  const inRun: InRunText[] = [];
  let skipped = 0;
  let revisions = 0;

  for (const item of selected) {
    // 每个平台独立判断是否需要生成（半成品品只补缺的平台）
    const need: Platform[] = [];
    for (const platform of PLATFORMS) {
      const prior = existingMap.get(`${item.productId}|${platform}`);
      // confirmed 是门③ 产物：--force 也不动（否则决策流水指向的内容被替换，审计留痕脱钩；重做须先 discard）
      // draft 未 --force 时跳过；needs_manual / discarded 重跑即重试 / 重做（discard 后重新生成是新的一版）
      const keep = prior != null && (prior.status === 'confirmed' || (prior.status === 'draft' && !opts.force));
      if (keep) {
        skipped += 1;
        // 当日已定稿草稿预填比对池：history 窗口 [since, date) 不含今天，
        // 同日多批生成（追加勾选 / 补跑）时新品不得与当日已落库内容撞车
        if (prior!.content !== null) {
          inRun.push({
            platform,
            externalId: prior!.externalId,
            batchDate: prior!.batchDate,
            title: draftDisplayTitle(platform, prior!.content!),
            text: draftText(platform, prior!.content!),
          });
        }
      } else {
        need.push(platform);
      }
    }
    if (need.length === 0) continue;

    const product = {
      productId: item.productId,
      externalId: item.externalId,
      title: item.title,
      category: item.category,
      price: item.price,
      sales30d: item.sales30d,
      momTrend: item.momTrend,
      reviewRate: item.reviewRate,
      reason: item.reason,
    };

    // 深度调研摘要（模块① V2，可选参考）：有则注入生成上下文（买家关注点 = 素材）
    const researchRow = await repo.getResearch(item.productId);
    const research = researchRow
      ? {
          sentiment: researchRow.summary.sentiment,
          highlights: researchRow.summary.highlights,
          risks: researchRow.summary.risks,
          materialPoints: researchRow.summary.materialPoints,
        }
      : null;

    const current: { xiaohongshu: XiaohongshuNote | null; douyin: DouyinScript | null } = { xiaohongshu: null, douyin: null };
    let failureNote: string | null = null;
    const platformRevisions: Record<Platform, number> = { xiaohongshu: 0, douyin: 0 };

    if (agent) {
      const callAgent = async (req: ContentRequest) => {
        const startedAt = Date.now();
        try {
          const r = await agent.generate(req);
          await repo.saveLlmLog({
            runId: list.runId,
            purpose: 'content-gen:drafts',
            model: r.audit.model,
            skill: r.audit.skill,
            input: r.audit.input,
            output: r.audit.output,
            ok: true,
            latencyMs: Date.now() - startedAt,
          });
          return r;
        } catch (e) {
          await repo.saveLlmLog({
            runId: list.runId,
            purpose: 'content-gen:drafts',
            model: agent.name,
            skill: 'content-gen',
            input: { error: 'agent-threw', revision: (req.revision?.length ?? 0) > 0 },
            ok: false,
            error: String(e),
            latencyMs: Date.now() - startedAt,
          });
          throw e;
        }
      };

      // 第 0 轮：首次生成（带历史参考 + 调研摘要参考）
      try {
        const r = await callAgent({ runId: list.runId, product, references: references.length > 0 ? references : null, research });
        current.xiaohongshu = r.xiaohongshu;
        current.douyin = r.douyin;
      } catch (e) {
        failureNote = `agent 异常: ${e instanceof Error ? e.message : String(e)}`;
      }

      // 修订循环：L1 检查（结构/词表/去重）命中 → 修订；预算 maxRevisions 轮
      if (!failureNote) {
        for (let round = 0; round < maxRevisions; round += 1) {
          const tasks: ContentRevisionTask[] = [];
          for (const platform of need) {
            const outcome = checkPlatform(platform, current[platform], history, inRun);
            if (outcome.issues.length > 0) {
              tasks.push({ platform, issues: outcome.issues, previous: current[platform] });
            }
          }
          if (tasks.length === 0) break;
          revisions += 1;
          for (const t of tasks) platformRevisions[t.platform] += 1;
          try {
            const r = await callAgent({ runId: list.runId, product, revision: tasks });
            for (const t of tasks) {
              // 未产出则保留旧版，下一轮继续或耗尽预算
              if (t.platform === 'xiaohongshu' && r.xiaohongshu) current.xiaohongshu = r.xiaohongshu;
              if (t.platform === 'douyin' && r.douyin) current.douyin = r.douyin;
            }
          } catch {
            // 修订调用失败：内容不变，占用一轮预算（有界重试，不无限烧钱）
          }
        }
      }
    } else {
      failureNote = '未配置 LLM（无 OPENAI_API_KEY），需人工撰写';
    }

    // 定稿：按平台落 needs_manual / draft
    for (const platform of need) {
      const content = current[platform];
      const rc = platformRevisions[platform];
      const outcome = checkPlatform(platform, content, history, inRun);

      if (content && outcome.valid && outcome.bannedHits.length === 0) {
        // draft：L2 审查（仅提示层）+ 去重提示
        let review: ContentReviewRecord | null = null;
        if (reviewer) {
          const startedAt = Date.now();
          try {
            const rr = await reviewer.review({ platform, content, product });
            review = { pass: rr.pass, risks: rr.risks, model: reviewer.name };
            await repo.saveLlmLog({
              runId: list.runId,
              purpose: 'content-gen:review',
              model: reviewer.name,
              skill: 'content-review',
              input: { platform, externalId: item.externalId },
              output: rr,
              ok: true,
              latencyMs: Date.now() - startedAt,
            });
          } catch (e) {
            review = {
              pass: null,
              risks: [],
              model: reviewer.name,
              skippedReason: `审查异常: ${e instanceof Error ? e.message : String(e)}`,
            };
            await repo.saveLlmLog({
              runId: list.runId,
              purpose: 'content-gen:review',
              model: reviewer.name,
              skill: 'content-review',
              input: { platform, externalId: item.externalId },
              ok: false,
              error: String(e),
              latencyMs: Date.now() - startedAt,
            });
          }
        }

        const notes: string[] = [];
        if (outcome.duplicates.length > 0) {
          notes.push(
            `与近期草稿相似: ${outcome.duplicates.map((d) => `${d.batchDate}「${d.title}」${d.similarity.toFixed(2)}`).join('、')}`,
          );
        }
        if (review?.pass === false) {
          notes.push(`LLM 审查提示（仅提示，门③ 终判）: ${review.risks.map((r) => `[${r.type}] ${r.detail}`).join('；')}`);
        }
        toSave.push({
          runId: list.runId,
          batchDate: date,
          productId: item.productId,
          platform,
          status: 'draft',
          content,
          bannedHits: [],
          review,
          duplicates: outcome.duplicates,
          revisionCount: rc,
          note: notes.length > 0 ? notes.join('；') : null,
          source: 'llm',
        });
        inRun.push({ platform, externalId: item.externalId, batchDate: date, title: draftDisplayTitle(platform, content), text: draftText(platform, content) });
      } else if (content && outcome.valid && outcome.bannedHits.length > 0) {
        // 词表命中修不掉（修订预算已耗尽）→ 硬语义：交人重写，命中词留痕
        toSave.push({
          runId: list.runId,
          batchDate: date,
          productId: item.productId,
          platform,
          status: 'needs_manual',
          content: null,
          bannedHits: outcome.bannedHits,
          review: null,
          duplicates: [],
          revisionCount: rc,
          note: `词表命中未修复${rc > 0 ? `（已修订 ${rc} 轮）` : ''}: ${outcome.bannedHits.join('、')}`,
          source: 'llm',
        });
      } else {
        // 缺失产出 / 结构不过（修订已尽力）
        const reason = !content
          ? (failureNote ?? 'agent 未产出该平台草稿')
          : `草稿校验不过（长度/结构不符${rc > 0 ? `，已修订 ${rc} 轮` : ''}）`;
        toSave.push({
          runId: list.runId,
          batchDate: date,
          productId: item.productId,
          platform,
          status: 'needs_manual',
          content: null,
          bannedHits: [],
          review: null,
          duplicates: [],
          revisionCount: rc,
          note: reason,
          source: 'llm',
        });
      }
    }
  }

  if (toSave.length > 0) await repo.saveContentDrafts(toSave);

  const drafts = await repo.getContentDrafts(date);
  const generated = toSave.filter((d) => d.status === 'draft').length;
  const needsManual = toSave.filter((d) => d.status === 'needs_manual').length;

  return {
    date,
    runId: list.runId,
    productCount: selected.length,
    generated,
    needsManual,
    skipped,
    bannedHitCount: drafts.filter((d) => d.bannedHits.length > 0).length,
    reviewed: toSave.filter((d) => d.review !== null && d.review.pass !== null).length,
    revisions,
    duplicateHitCount: drafts.filter((d) => d.duplicates.length > 0).length,
    degraded: drafts.some((d) => d.status === 'needs_manual'),
    drafts,
  };
}
