/**
 * Fastify 业务 API（给 Web 勾选门用）。
 * GET  /api/health                      探活（免鉴权）
 * GET  /api/daily-list?date=YYYY-MM-DD  今日候选清单
 * POST /api/select { date, externalIds: string[], note? }
 * GET  /api/rules                       当前 active 规则
 *
 * 鉴权（对抗测试 P1 修复）：
 * - 默认绑定 127.0.0.1（单人本机场景，免 token）
 * - 配置 GWD_API_TOKEN 后：除 /api/health 外所有请求必须带 x-api-token 头
 *   （或 Authorization: Bearer <token>），此时才允许 HOST=0.0.0.0 暴露到内网
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnv } from '../env.js';
import { PgRepo } from '../db/pg-repo.js';
import type { Repo } from '../db/repo.js';
import { selectProducts } from '../pipeline/select.js';
import { todayShanghai } from '../util.js';

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
    const list = await db.getDailyList(date);
    if (!list) return reply.code(404).send({ error: `${date} 没有清单，先跑 daily-scan` });
    return list;
  });

  app.post<{ Body: { date?: string; externalIds: string[]; note?: string } }>('/api/select', async (req, reply) => {
    const { date, externalIds, note } = req.body ?? ({} as { externalIds: never[] });
    if (!Array.isArray(externalIds) || externalIds.length === 0) {
      return reply.code(400).send({ error: 'externalIds 不能为空' });
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
