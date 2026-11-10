/**
 * Fastify 业务 API（给 Web 勾选门用）。
 * GET  /api/health                      探活（免鉴权）
 * GET  /api/daily-list?date=YYYY-MM-DD  今日候选清单
 * POST /api/select { date, externalIds: string[], note? }
 * GET  /api/rules                       当前 active 规则
 * GET  /api/dashboard/sim?author=      模拟数据账号看板（P1，只读）
 * GET  /api/dashboard/real?author=     真实数据账号看板（P1，只读）
 * GET  /api/contents?date=             内容草稿列表 + 门③ 5 项清单（P1，只读）
 * POST /api/confirm  { date?, externalId, platform, answers[5], note? }  门③ 人工确认（决策流水 append-only）
 * POST /api/discard  { date?, externalId, platform, note? }              弃用草稿（决策流水 append-only）
 * GET  /api/publish?date=              待发布队列 + 已发布台账（P1，只读；发布动作永远人工）
 * POST /api/publish-sync { date? }      门③ confirmed → pending 队列（幂等，可重跑补漏）
 * POST /api/published { date?, externalId, platform, url, publishedAt?, aiLabeled?, videoId? }  回填台账（一条只回填一次）
 * GET  /api/attribution?days=&platform=   内容层表现归因（模块⑤，只读；发布台账 join 真实表现 by video_id）
 * POST /api/attribution-link { date?, externalId, platform, videoId }  补链归因 video_id（幂等可重跑）
 * GET  /api/product-attribution?days=     品级成交归因（模块⑤ 5/5，只读；发布台账按品 join 商品层成交 by product_id）
 *
 * 鉴权（对抗测试 P1 修复）：
 * - 默认绑定 127.0.0.1（单人本机场景，免 token）
 * - 配置 GWD_API_TOKEN 后：除 /api/health 外所有请求必须带 x-api-token 头
 *   （或 Authorization: Bearer <token>），此时才允许 HOST=0.0.0.0 暴露到内网
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { loadEnv } from '../env.js';
import { PgRepo } from '../db/pg-repo.js';
import type { Repo } from '../db/repo.js';
import { selectProducts } from '../pipeline/select.js';
import { runSimDashboard } from '../pipeline/sim-dashboard.js';
import { runRealDashboard } from '../pipeline/real-dashboard.js';
import { confirmContentDraft, discardContentDraft, GATE3_CHECKLIST } from '../pipeline/content-confirm.js';
import { listPublishQueue, recordPublish, syncPublishQueue } from '../pipeline/publish.js';
import { buildAttribution, linkVideoId } from '../pipeline/attribution.js';
import { buildProductAttribution } from '../pipeline/product-attribution.js';
import { parseVideoId } from '../core/video-id.js';
import { isValidBatchDate, todayShanghai } from '../util.js';

loadEnv();

export async function buildServer(repo?: Repo) {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const db = repo ?? new PgRepo(process.env.DATABASE_URL ?? 'postgres://gwd:gwd@localhost:5432/gwd');

  // —— 鉴权门：配置了 token 才启用（未配置 = 仅本机回环使用的设计内默认）——
  const apiToken = process.env.GWD_API_TOKEN;
  if (apiToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.split('?')[0] === '/api/health') return; // 探活免鉴权
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const provided = String(req.headers['x-api-token'] ?? '') || bearer;
      if (provided !== apiToken) {
        return reply.code(401).send({ error: '无效 API token（需要 x-api-token 头）' });
      }
    });
  }

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/daily-list', async (req, reply) => {
    const q = req.query as { date?: string };
    const date = q.date ?? todayShanghai();
    if (!isValidBatchDate(date)) {
      return reply.code(400).send({ error: `date 格式无效（须 YYYY-MM-DD，收到 "${date}"）` });
    }
    const list = await db.getDailyList(date);
    if (!list) return reply.code(404).send({ error: `${date} 没有清单，先跑 daily-scan` });
    return list;
  });

  app.post<{ Body: { date?: string; externalIds: string[]; note?: string } }>('/api/select', async (req, reply) => {
    const { date, externalIds, note } = req.body ?? ({} as { externalIds: never[] });
    if (!Array.isArray(externalIds) || externalIds.length === 0) {
      return reply.code(400).send({ error: 'externalIds 不能为空' });
    }
    if (date != null && !isValidBatchDate(date)) {
      return reply.code(400).send({ error: `date 格式无效（须 YYYY-MM-DD，收到 "${date}"）` });
    }
    try {
      const result = await selectProducts({ repo: db, date, externalIds, note });
      return result;
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/rules', async (_req, reply) => {
    const rule = await db.getActiveRule();
    if (!rule) return reply.code(404).send({ error: '没有 active 规则' });
    return rule;
  });

  // —— 账号看板（P1 Web 数据看板）：只读，双源按 source 隔离，各自带数据源声明 ——
  // 对抗修复（P1 审查攻破 2 项）：author 是唯一外部输入，入口白名单校验——
  // 修复前 ① 数组参数触发 TypeError 500 且泄漏代码片段；② 错误回显无截断（超长/控制字符/注入串全量反射）
  const AUTHOR_RE = /^[\w\u4e00-\u9fff.-]+$/;
  const dashboardHandler =
    (run: (opts: { repo: Repo; authorId?: string }) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = (req.query as { author?: unknown }).author;
      let authorId: string | undefined;
      if (raw != null && raw !== '') {
        if (typeof raw !== 'string') {
          return reply.code(400).send({ error: 'author 参数无效（只接受单个字符串）' });
        }
        const a = raw.trim();
        if (a.length === 0) authorId = undefined;
        else if (a.length > 64) return reply.code(400).send({ error: 'author 过长（≤64 字符）' });
        else if (/[\u0000-\u001f\u007f]/.test(a)) return reply.code(400).send({ error: 'author 含非法控制字符' });
        else if (!AUTHOR_RE.test(a)) return reply.code(400).send({ error: 'author 含非法字符（仅限字母/数字/中文/._-）' });
        else authorId = a;
      }
      try {
        return await run({ repo: db, authorId });
      } catch (e) {
        // 管线对「空数据 / 账号不存在」都 throw 中文 message（含下一步指引）
        return reply.code(404).send({ error: e instanceof Error ? e.message : String(e) });
      }
    };

  app.get('/api/dashboard/sim', dashboardHandler(runSimDashboard));
  app.get('/api/dashboard/real', dashboardHandler(runRealDashboard));

  // —— 内容工坊（门③ Web 确认页）：草稿只读 + 人工确认/弃用（写操作 append-only 决策流水）——
  // 外部输入沿用看板对抗修复结论：入口白名单四层校验（类型/长度/控制字符/字符集），错误一律 400 且不回显原文
  const EXTERNAL_ID_RE = /^[\w\u4e00-\u9fff.-]+$/;
  const PLATFORMS = new Set(['xiaohongshu', 'douyin']);

  /** externalId 白名单校验：通过返回清洗值，不通过返回错误文案（不含原文） */
  function checkExternalId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof raw !== 'string') return { ok: false, error: 'externalId 参数无效（只接受单个字符串）' };
    const v = raw.trim();
    if (v.length === 0) return { ok: false, error: 'externalId 不能为空' };
    if (v.length > 64) return { ok: false, error: 'externalId 过长（≤64 字符）' };
    if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'externalId 含非法控制字符' };
    if (!EXTERNAL_ID_RE.test(v)) return { ok: false, error: 'externalId 含非法字符（仅限字母/数字/中文/._-）' };
    return { ok: true, value: v };
  }

  /** confirm/discard 共用的请求体校验：date（可选）/ externalId / platform */
  function parseGate3Body(body: Record<string, unknown>): { date: string; externalId: string; platform: string } | { error: string } {
    // 对抗修复：非字符串 date（数组/对象）曾静默回退到「今天」——错误语义落到错误日期，现显式 400
    if (body.date != null && typeof body.date !== 'string') return { error: 'date 参数无效（只接受 YYYY-MM-DD 字符串）' };
    const date = typeof body.date === 'string' && body.date !== '' ? body.date : todayShanghai();
    if (!isValidBatchDate(date)) return { error: 'date 格式无效（须 YYYY-MM-DD）' };
    const id = checkExternalId(body.externalId);
    if (!id.ok) return { error: id.error };
    if (typeof body.platform !== 'string' || !PLATFORMS.has(body.platform)) {
      return { error: 'platform 无效（只接受 xiaohongshu | douyin）' };
    }
    if (body.note != null && typeof body.note !== 'string') return { error: 'note 参数无效（只接受字符串）' };
    return { date, externalId: id.value, platform: body.platform };
  }

  app.get('/api/contents', async (req, reply) => {
    const q = req.query as { date?: string };
    const date = q.date ?? todayShanghai();
    if (!isValidBatchDate(date)) {
      return reply.code(400).send({ error: 'date 格式无效（须 YYYY-MM-DD）' });
    }
    const drafts = await db.getContentDrafts(date);
    return { date, checklist: GATE3_CHECKLIST, drafts };
  });

  app.post<{ Body: { date?: string; externalId?: string; platform?: string; answers?: unknown; note?: string } }>(
    '/api/confirm',
    async (req, reply) => {
      const body = req.body ?? {};
      const parsed = parseGate3Body(body);
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      // answers 形状校验在入口（数量/全布尔）；「5 项必须全确认」的业务规则仍由管线终判
      if (!Array.isArray(body.answers) || body.answers.length !== GATE3_CHECKLIST.length) {
        return reply.code(400).send({ error: `answers 须为 ${GATE3_CHECKLIST.length} 项布尔数组（收到 ${Array.isArray(body.answers) ? body.answers.length : '非数组'} 项）` });
      }
      if (!body.answers.every((a) => typeof a === 'boolean')) {
        return reply.code(400).send({ error: 'answers 每项须为布尔值（true/false）' });
      }
      try {
        const result = await confirmContentDraft({
          repo: db,
          date: parsed.date,
          externalId: parsed.externalId,
          platform: parsed.platform as 'xiaohongshu' | 'douyin',
          answers: body.answers,
          note: body.note,
        });
        return result;
      } catch (e) {
        // 管线错误 = 状态冲突（清单未全确认/幂等拦截/硬拦截/草稿不存在），消息只含已过白名单的输入
        return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.post<{ Body: { date?: string; externalId?: string; platform?: string; note?: string } }>(
    '/api/discard',
    async (req, reply) => {
      const body = req.body ?? {};
      const parsed = parseGate3Body(body);
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
      try {
        const result = await discardContentDraft({
          repo: db,
          date: parsed.date,
          externalId: parsed.externalId,
          platform: parsed.platform as 'xiaohongshu' | 'douyin',
          note: body.note,
        });
        return result;
      } catch (e) {
        return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // —— 发布队列 + 台账（门④：发布动作永远人工，系统只做记录与提醒）——
  // 入口白名单先于管线：url 协议/长度/控制字符在 API 层 400 且不回显原文（管线校验保留给 CLI 路径）
  function checkPublishBody(body: Record<string, unknown>):
    | { ok: true; date: string; externalId: string; platform: string; url: string; publishedAt?: string; aiLabeled?: boolean; videoId?: string }
    | { ok: false; error: string } {
    if (body.date != null && typeof body.date !== 'string') return { ok: false, error: 'date 参数无效（只接受 YYYY-MM-DD 字符串）' };
    const date = typeof body.date === 'string' && body.date !== '' ? body.date : todayShanghai();
    if (!isValidBatchDate(date)) return { ok: false, error: 'date 格式无效（须 YYYY-MM-DD）' };
    const id = checkExternalId(body.externalId);
    if (!id.ok) return { ok: false, error: id.error };
    if (typeof body.platform !== 'string' || !PLATFORMS.has(body.platform)) {
      return { ok: false, error: 'platform 无效（只接受 xiaohongshu | douyin）' };
    }
    if (typeof body.url !== 'string') return { ok: false, error: 'url 参数无效（只接受字符串）' };
    const url = body.url.trim();
    if (url.length === 0) return { ok: false, error: 'url 不能为空' };
    if (url.length > 500) return { ok: false, error: 'url 过长（≤500 字符）' };
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url 须以 http:// 或 https:// 开头' };
    if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, error: 'url 不能包含换行/控制字符' };
    if (body.publishedAt != null && body.publishedAt !== '') {
      if (typeof body.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}([T]|$)/.test(body.publishedAt)) {
        return { ok: false, error: 'publishedAt 格式无效（须 ISO 格式，如 2026-01-05T21:00:00+08:00）' };
      }
    } else if (body.publishedAt !== undefined && typeof body.publishedAt !== 'string') {
      return { ok: false, error: 'publishedAt 参数无效（只接受字符串）' };
    }
    // 对抗修复：显式 null 曾被静默转为 false（AI 标注状态不可被 null 绕过）——现 null 一律 400，仅 undefined 走默认
    if (body.aiLabeled !== undefined && typeof body.aiLabeled !== 'boolean') {
      return { ok: false, error: 'aiLabeled 参数无效（只接受布尔值）' };
    }
    // 归因锚点（模块⑤）：undefined = 不回填；null / 非字符串 / 非法载荷一律 400（不静默吞）
    let videoId: string | undefined;
    if (body.videoId !== undefined) {
      if (body.videoId === null || body.videoId === '') return { ok: false, error: 'videoId 参数无效（不回填请省略该字段，不要传 null/空串）' };
      const parsed = parseVideoId(body.videoId);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      videoId = parsed.value;
    }
    return {
      ok: true,
      date,
      externalId: id.value,
      platform: body.platform,
      url,
      publishedAt: typeof body.publishedAt === 'string' && body.publishedAt !== '' ? body.publishedAt : undefined,
      aiLabeled: body.aiLabeled === true,
      videoId,
    };
  }

  app.get('/api/publish', async (req, reply) => {
    const q = req.query as { date?: string };
    const date = q.date ?? todayShanghai();
    if (!isValidBatchDate(date)) {
      return reply.code(400).send({ error: 'date 格式无效（须 YYYY-MM-DD）' });
    }
    const items = await listPublishQueue({ repo: db, date });
    return { date, items };
  });

  app.post<{ Body: { date?: string } }>('/api/publish-sync', async (req, reply) => {
    const body = req.body ?? {};
    if (body.date != null && typeof body.date !== 'string') return reply.code(400).send({ error: 'date 参数无效（只接受 YYYY-MM-DD 字符串）' });
    const date = typeof body.date === 'string' && body.date !== '' ? body.date : todayShanghai();
    if (!isValidBatchDate(date)) return reply.code(400).send({ error: 'date 格式无效（须 YYYY-MM-DD）' });
    const result = await syncPublishQueue({ repo: db, date });
    return result;
  });

  app.post<{ Body: { date?: string; externalId?: string; platform?: string; url?: string; publishedAt?: string; aiLabeled?: boolean; videoId?: string } }>(
    '/api/published',
    async (req, reply) => {
      const body = req.body ?? {};
      const parsed = checkPublishBody(body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      try {
        const result = await recordPublish({
          repo: db,
          date: parsed.date,
          externalId: parsed.externalId,
          platform: parsed.platform as 'xiaohongshu' | 'douyin',
          url: parsed.url,
          publishedAt: parsed.publishedAt,
          aiLabeled: parsed.aiLabeled,
          videoId: parsed.videoId,
        });
        // record 含完整 PublishRecordRow（id/runId 等），Web 台账展示够用
        return { date: result.date, externalId: result.externalId, platform: result.platform, record: result.record };
      } catch (e) {
        // 管线错误 = 状态冲突（未确认/无队列记录/重复回填），消息只含已过白名单的输入
        return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // —— 内容层表现归因（模块⑤：只读报表，source 锁 manual，零 LLM）——
  app.get('/api/attribution', async (req, reply) => {
    const q = req.query as { days?: string; platform?: string };
    let days: number | undefined;
    if (q.days != null && q.days !== '') {
      const n = Number(q.days);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return reply.code(400).send({ error: 'days 参数无效（1-90 的整数）' });
      }
      days = n;
    }
    let platform: string | undefined;
    if (q.platform != null && q.platform !== '') {
      if (typeof q.platform !== 'string' || !PLATFORMS.has(q.platform)) {
        return reply.code(400).send({ error: 'platform 无效（只接受 xiaohongshu | douyin）' });
      }
      platform = q.platform;
    }
    try {
      const report = await buildAttribution({
        repo: db,
        days,
        platform: platform as 'xiaohongshu' | 'douyin' | undefined,
      });
      return report;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: { date?: string; externalId?: string; platform?: string; videoId?: string } }>(
    '/api/attribution-link',
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.date != null && typeof body.date !== 'string') return reply.code(400).send({ error: 'date 参数无效（只接受 YYYY-MM-DD 字符串）' });
      const date = typeof body.date === 'string' && body.date !== '' ? body.date : todayShanghai();
      if (!isValidBatchDate(date)) return reply.code(400).send({ error: 'date 格式无效（须 YYYY-MM-DD）' });
      const id = checkExternalId(body.externalId);
      if (!id.ok) return reply.code(400).send({ error: id.error });
      if (typeof body.platform !== 'string' || !PLATFORMS.has(body.platform)) {
        return reply.code(400).send({ error: 'platform 无效（只接受 xiaohongshu | douyin）' });
      }
      const parsedVideo = parseVideoId(body.videoId);
      if (!parsedVideo.ok) return reply.code(400).send({ error: parsedVideo.error });
      try {
        const result = await linkVideoId({
          repo: db,
          date,
          externalId: id.value,
          platform: body.platform as 'xiaohongshu' | 'douyin',
          videoId: parsedVideo.value,
        });
        return result;
      } catch (e) {
        return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  // —— 品级成交归因（模块⑤ 5/5：只读报表，商品层 source 锁 manual，零 LLM）——
  app.get('/api/product-attribution', async (req, reply) => {
    const q = req.query as { days?: string };
    let days: number | undefined;
    if (q.days != null && q.days !== '') {
      const n = Number(q.days);
      if (!Number.isInteger(n) || n < 1 || n > 90) {
        return reply.code(400).send({ error: 'days 参数无效（1-90 的整数）' });
      }
      days = n;
    }
    try {
      const report = await buildProductAttribution({ repo: db, days });
      return report;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return { app, close: async () => db.close() };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('src/api/server.ts');
if (isMain) {
  const { app, close } = await buildServer();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1'; // 默认只绑本机；要暴露必须配 GWD_API_TOKEN
  if (host !== '127.0.0.1' && !process.env.GWD_API_TOKEN) {
    console.warn('⚠ HOST 非 127.0.0.1 但未配置 GWD_API_TOKEN——API 将无鉴权暴露，仅限可信内网！');
  }
  await app.listen({ port, host });
  console.log(`API 已启动: http://${host}:${port}（鉴权: ${process.env.GWD_API_TOKEN ? '已启用' : '未启用（本机默认）'}。勾选门页面见 web/）`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await app.close();
      await close();
      process.exit(0);
    });
  }
}
