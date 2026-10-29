/**
 * Fastify 业务 API（MVP：给 Web 勾选门用，仅本机/内网使用，无鉴权）。
 * GET  /api/health
 * GET  /api/daily-list?date=YYYY-MM-DD
 * POST /api/select { date, externalIds: string[], note? }
 * GET  /api/rules（当前 active 规则）
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnv } from '../env.js';
import { PgRepo } from '../db/pg-repo.js';
import { selectProducts } from '../pipeline/select.js';
import { todayShanghai } from '../util.js';

loadEnv();

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  const repo = new PgRepo(process.env.DATABASE_URL ?? 'postgres://gwd:gwd@localhost:5432/gwd');

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/daily-list', async (req, reply) => {
    const q = req.query as { date?: string };
    const date = q.date ?? todayShanghai();
    const list = await repo.getDailyList(date);
    if (!list) return reply.code(404).send({ error: `${date} 没有清单，先跑 daily-scan` });
    return list;
  });

  app.post<{ Body: { date?: string; externalIds: string[]; note?: string } }>('/api/select', async (req, reply) => {
    const { date, externalIds, note } = req.body ?? ({} as { externalIds: never[] });
    if (!Array.isArray(externalIds) || externalIds.length === 0) {
      return reply.code(400).send({ error: 'externalIds 不能为空' });
    }
    try {
      const result = await selectProducts({ repo, date, externalIds, note });
      return result;
    } catch (e) {
      return reply.code(409).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/rules', async (_req, reply) => {
    const rule = await repo.getActiveRule();
    if (!rule) return reply.code(404).send({ error: '没有 active 规则' });
    return rule;
  });

  return { app, close: async () => repo.close() };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('src/api/server.ts');
if (isMain) {
  const { app, close } = await buildServer();
  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`API 已启动: http://localhost:${port}（勾选门页面见 web/）`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await app.close();
      await close();
      process.exit(0);
    });
  }
}
