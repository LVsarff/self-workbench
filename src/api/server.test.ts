/**
 * API 鉴权回归（对抗测试 P1 修复）：
 * - 未配置 token = 本机回环默认场景，接口免鉴权
 * - 配置 GWD_API_TOKEN 后：除 /api/health 外全部要求 x-api-token / Bearer
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';

const ORIGINAL_TOKEN = process.env.GWD_API_TOKEN;

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.GWD_API_TOKEN;
  else process.env.GWD_API_TOKEN = ORIGINAL_TOKEN;
});

describe('API 鉴权（P1 修复回归）', () => {
  it('未配置 token（本机默认）：接口正常访问，无 401', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app } = await buildServer(new MemoryRepo());
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/daily-list?date=2026-01-05' });
    expect(list.statusCode).toBe(404); // 无清单，但不是 401
    expect(list.json()).toMatchObject({ error: expect.stringContaining('没有清单') });
    await app.close();
  });

  it('配置 token：无头 / 错 token → 401；health 仍免鉴权', async () => {
    process.env.GWD_API_TOKEN = 'secret-token';
    const { app } = await buildServer(new MemoryRepo());
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/daily-list?date=2026-01-05' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/daily-list?date=2026-01-05', headers: { 'x-api-token': '错的' } })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/select', headers: { 'x-api-token': '错的' }, payload: { date: '2026-01-05', externalIds: ['A'] } })).statusCode,
    ).toBe(401);
    await app.close();
  });

  it('配置 token：正确 token（x-api-token 头或 Bearer）→ 放行', async () => {
    process.env.GWD_API_TOKEN = 'secret-token';
    const repo = new MemoryRepo();
    await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
    const { app } = await buildServer(repo);
    expect((await app.inject({ method: 'GET', url: '/api/rules', headers: { 'x-api-token': 'secret-token' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/rules', headers: { authorization: 'Bearer secret-token' } })).statusCode).toBe(200);
    await app.close();
  });
});
