/**
 * API 鉴权回归（对抗测试 P1 修复）：
 * - 未配置 token = 本机回环默认场景，接口免鉴权
 * - 配置 GWD_API_TOKEN 后：除 /api/health 外全部要求 x-api-token / Bearer
 * - P1 看板端点：只读、双源按 source 隔离、各带数据源声明
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import type { SimContentStatRow } from '../db/repo.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { selectProducts } from '../pipeline/select.js';
import { runContentGen } from '../pipeline/content-gen.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { confirmContentDraft, GATE3_CHECKLIST } from '../pipeline/content-confirm.js';
import { syncPublishQueue } from '../pipeline/publish.js';

const ORIGINAL_TOKEN = process.env.GWD_API_TOKEN;

function stat(overrides: Partial<SimContentStatRow> = {}): SimContentStatRow {
  return {
    source: 'kuairec',
    videoId: 'v1',
    authorId: 'A1',
    statDate: '2026-01-05',
    videoType: 'NORMAL',
    uploadDt: '2025-12-01',
    videoDuration: 10000,
    videoTagName: null,
    showCnt: 1000,
    playCnt: 500,
    completePlayCnt: 300,
    likeCnt: 50,
    commentCnt: 5,
    shareCnt: 5,
    followCnt: 10,
    collectCnt: 8,
    reportCnt: 0,
    caption: '测试文案',
    topicTag: null,
    category: '颜值·颜值随拍',
    ...overrides,
  };
}

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

  it('坏日期格式 → 400 硬校验（不再落到 DB 报 500）', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app } = await buildServer(new MemoryRepo());
    for (const bad of ['2026-13-45', 'not-a-date', '2026-02-31', '20261028']) {
      const list = await app.inject({ method: 'GET', url: `/api/daily-list?date=${encodeURIComponent(bad)}` });
      expect(list.statusCode, `GET daily-list date=${bad}`).toBe(400);
      expect(list.json()).toMatchObject({ error: expect.stringContaining('date 格式无效') });
    }
    const post = await app.inject({ method: 'POST', url: '/api/select', payload: { date: '2026-13-45', externalIds: ['A'] } });
    expect(post.statusCode).toBe(400);
    expect(post.json()).toMatchObject({ error: expect.stringContaining('date 格式无效') });
    // 合法格式（含闰日）不受影响：走正常 404/409 路径而非 400
    expect((await app.inject({ method: 'GET', url: '/api/daily-list?date=2024-02-29' })).statusCode).toBe(404);
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

describe('看板端点（P1）：/api/dashboard/sim 与 /api/dashboard/real', () => {
  /** A1 双源都有数据（kuairec 曝光 1000 / manual 曝光 500）；A2 只有 kuairec；A3 只有 manual */
  async function seededRepo() {
    const repo = new MemoryRepo();
    await repo.upsertSimStats([stat({ showCnt: 1000 }), stat({ statDate: '2026-01-06', showCnt: 20000 })]);
    await repo.upsertSimStats([stat({ source: 'manual', showCnt: 500 })]);
    await repo.upsertSimStats([stat({ authorId: 'A2', videoId: 'v9', showCnt: 7000 })]);
    await repo.upsertSimStats([stat({ source: 'manual', authorId: 'A3', videoId: 'v8', showCnt: 300 })]);
    return repo;
  }

  it('sim 看板：200 + 数据形状（声明/总量/日趋势/Top 内容/账号一览）', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app } = await buildServer(await seededRepo());
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/sim' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dashboard.disclaimer).toContain('模拟数据');
    expect(body.dashboard.authorId).toBe('A1'); // 缺省取总曝光第一（A1 21000 > A2 7000）
    expect(body.dashboard.totals.showCnt).toBe(21000);
    expect(body.dashboard.daily).toHaveLength(2);
    expect(body.dashboard.daily[0]).toMatchObject({ date: '2026-01-05', showCnt: 1000 });
    expect(body.dashboard.topContents.length).toBeGreaterThan(0);
    expect(body.topAuthors.map((a: { authorId: string }) => a.authorId)).toContain('A2');
    await app.close();
  });

  it('real 看板：200 + 声明含「真实数据」+ 与模拟数据不混读（500 ≠ 21000）', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app } = await buildServer(await seededRepo());
    const res = await app.inject({ method: 'GET', url: '/api/dashboard/real' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dashboard.disclaimer).toContain('真实数据');
    expect(body.dashboard.authorId).toBe('A1'); // real 侧 A1 500 > A3 300
    expect(body.dashboard.totals.showCnt).toBe(500); // 只算 manual 行，绝不串 kuairec
    expect(body.topAuthors.map((a: { authorId: string }) => a.authorId)).not.toContain('A2'); // kuairec-only 账号不出现
    await app.close();
  });

  it('author 参数切换账号 + 双源隔离：kuairec-only 账号在 real 端点 404，反之亦然', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app } = await buildServer(await seededRepo());
    const a2 = await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=A2' });
    expect(a2.statusCode).toBe(200);
    expect(a2.json().dashboard.authorId).toBe('A2');
    expect(a2.json().dashboard.totals.showCnt).toBe(7000);

    expect((await app.inject({ method: 'GET', url: '/api/dashboard/real?author=A2' })).statusCode).toBe(404); // 模拟账号看不到真实看板
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=A3' })).statusCode).toBe(404); // 真实账号看不到模拟看板
    await app.close();
  });

  it('空数据 / 不存在账号 → 404 + 中文指引（先跑 sim-import / real-import）', async () => {
    delete process.env.GWD_API_TOKEN;
    const empty = await buildServer(new MemoryRepo());
    const sim = await empty.app.inject({ method: 'GET', url: '/api/dashboard/sim' });
    expect(sim.statusCode).toBe(404);
    expect(sim.json().error).toContain('sim-import');
    const real = await empty.app.inject({ method: 'GET', url: '/api/dashboard/real' });
    expect(real.statusCode).toBe(404);
    expect(real.json().error).toContain('real-import');
    expect((await empty.app.inject({ method: 'GET', url: '/api/dashboard/sim?author=%E4%B8%8D%E5%AD%98%E5%9C%A8' })).statusCode).toBe(404);
    await empty.app.close();
  });

  it('配置 token：看板端点同样受鉴权保护', async () => {
    process.env.GWD_API_TOKEN = 'secret-token';
    const { app } = await buildServer(await seededRepo());
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/real' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/dashboard/sim', headers: { 'x-api-token': 'secret-token' } })).statusCode,
    ).toBe(200);
    await app.close();
  });
});

// —— 门③ Web 确认页端点（P1）——

const GATE3_DATE = '2026-01-05';
const ALL_TRUE = [true, true, true, true, true];

function snap(externalId: string, overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    externalId,
    title: `商品${externalId}`,
    category: '家居收纳',
    price: 39.9,
    commissionRate: 25,
    sales30d: 3200,
    momTrend: 'up',
    reviewRate: 96,
    returnRate: 2,
    merchantScore: 85,
    fulfillment: '现货',
    contentFriendliness: 5,
    competition: 4,
    repurchase: 5,
    imageUrl: null,
    ...overrides,
  };
}

/** 已生成草稿的仓储（A、B 各双平台，全 draft）——与 content-confirm.test.ts 同套路 */
async function draftedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B', { competition: 1 })], GATE3_DATE);
  await runDailyScan({ repo, date: GATE3_DATE, agent: null });
  await selectProducts({ repo, date: GATE3_DATE, externalIds: ['A', 'B'] });
  await runContentGen({ repo, date: GATE3_DATE, agent: createScriptedContentAgent() });
  return repo;
}

function confirmPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { date: GATE3_DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE, ...overrides };
}

describe('内容工坊端点（门③ Web）：/api/contents · /api/confirm · /api/discard', () => {
  it('GET /api/contents：200 + 草稿（含双版内容/审查/去重字段）+ 5 项清单来自后端单一事实源', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app, close } = await buildServer(await draftedRepo());
    const res = await app.inject({ method: 'GET', url: `/api/contents?date=${GATE3_DATE}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.date).toBe(GATE3_DATE);
    expect(body.checklist).toHaveLength(5);
    expect(body.checklist[0]).toContain('卖点属实');
    expect(body.drafts).toHaveLength(4); // A、B 各双平台
    const a = body.drafts.find((d: { externalId: string; platform: string }) => d.externalId === 'A' && d.platform === 'xiaohongshu');
    expect(a.status).toBe('draft');
    expect(a.content.title).toBeTypeOf('string');
    expect(a.bannedHits).toEqual([]);
    expect(a).toHaveProperty('review');
    expect(a).toHaveProperty('duplicates');
    expect(a).toHaveProperty('revisionCount');
    await app.close();
    await close();
  });

  it('GET /api/contents：无草稿日期 → 200 空列表（页面自会给出指引）；坏日期 → 400', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app, close } = await buildServer(await draftedRepo());
    const empty = await app.inject({ method: 'GET', url: '/api/contents?date=2026-02-01' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().drafts).toEqual([]);
    const bad = await app.inject({ method: 'GET', url: '/api/contents?date=2026-13-45' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('date 格式无效');
    await app.close();
    await close();
  });

  it('POST /api/confirm：5 项全确认 → 200，草稿状态推进 confirmed，决策流水 append-only 留痕', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await draftedRepo();
    const { app, close } = await buildServer(repo);
    const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ date: GATE3_DATE, externalId: 'A', platform: 'xiaohongshu' });

    const draft = (await repo.getContentDrafts(GATE3_DATE)).find((d) => d.externalId === 'A' && d.platform === 'xiaohongshu')!;
    expect(draft.status).toBe('confirmed');
    const decisions = await repo.getContentDecisions(GATE3_DATE);
    const decision = decisions.find((d) => d.platform === 'xiaohongshu' && d.action === 'confirmed')!;
    expect(decision.checklist!).toHaveLength(5);
    expect(decision.checklist!.every((c) => c.pass)).toBe(true);
    expect(decision.decidedBy).toBe('human');
    await app.close();
    await close();
  });

  it('POST /api/confirm：任一项未确认 → 409 并列出该项（不落任何决策）', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await draftedRepo();
    const { app, close } = await buildServer(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/api/confirm',
      payload: confirmPayload({ answers: [true, true, false, true, true] }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('符合账号人设');
    expect((await repo.getContentDecisions(GATE3_DATE)).filter((d) => d.action === 'confirmed')).toHaveLength(0);
    await app.close();
    await close();
  });

  it('POST /api/confirm：草稿不存在 → 409 中文指引；重复确认 → 409 幂等拦截', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await draftedRepo();
    const { app, close } = await buildServer(repo);
    const missing = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ externalId: 'C' }) });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toContain('没有找到');

    expect((await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('幂等拦截');
    await app.close();
    await close();
  });

  it('POST /api/confirm：answers 形状不对（缺项 / 非布尔 / 字符串）→ 400 入口拦截', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app, close } = await buildServer(await draftedRepo());
    for (const answers of [[true, true], [true, true, true, true, 'yes'], 'yyyyy', { 0: true }]) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ answers }) });
      expect(res.statusCode, `answers=${JSON.stringify(answers)}`).toBe(400);
      expect(res.json().error).toMatch(/answers/);
    }
    await app.close();
    await close();
  });

  it('POST /api/confirm：platform 不在白名单 → 400（不接受 CLI 的模糊别名）', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app, close } = await buildServer(await draftedRepo());
    for (const platform of ['xhs', '小红书', 'XIAOHONGSHU', 'wechat']) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ platform }) });
      expect(res.statusCode, `platform=${platform}`).toBe(400);
    }
    await app.close();
    await close();
  });

  it('POST /api/discard：200 + 决策流水 discarded；重复弃用 → 409', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await draftedRepo();
    const { app, close } = await buildServer(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/api/discard',
      payload: { date: GATE3_DATE, externalId: 'B', platform: 'douyin', note: '钩子不行' },
    });
    expect(res.statusCode).toBe(200);
    const draft = (await repo.getContentDrafts(GATE3_DATE)).find((d) => d.externalId === 'B' && d.platform === 'douyin')!;
    expect(draft.status).toBe('discarded');
    const decisions = await repo.getContentDecisions(GATE3_DATE);
    const decision = decisions.find((d) => d.platform === 'douyin' && d.action === 'discarded')!;
    expect(decision.note).toBe('钩子不行');
    expect(decision.checklist).toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: '/api/discard',
      payload: { date: GATE3_DATE, externalId: 'B', platform: 'douyin' },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
    await close();
  });

  it('配置 token：门③ 三个端点同样受鉴权保护', async () => {
    process.env.GWD_API_TOKEN = 'secret-token';
    const { app, close } = await buildServer(await draftedRepo());
    expect((await app.inject({ method: 'GET', url: `/api/contents?date=${GATE3_DATE}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/discard', payload: { externalId: 'A', platform: 'douyin' } })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/api/contents?date=${GATE3_DATE}`, headers: { 'x-api-token': 'secret-token' } })).statusCode,
    ).toBe(200);
    await app.close();
    await close();
  });
});

// —— 发布队列/台账端点（P1 门④ Web）——

/** A 双平台已确认 + B 双平台待确认的仓储 */
async function publishReadyRepo() {
  const repo = await draftedRepo();
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    await confirmContentDraft({ repo, date: GATE3_DATE, externalId: 'A', platform, answers: [true, true, true, true, true] });
  }
  return repo;
}

describe('发布队列/台账端点（门④ Web）：/api/publish · /api/publish-sync · /api/published', () => {
  it('POST /api/publish-sync：confirmed → pending 队列（幂等，重跑只补漏）', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await publishReadyRepo();
    const { app, close } = await buildServer(repo);
    const first = await app.inject({ method: 'POST', url: '/api/publish-sync', payload: { date: GATE3_DATE } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ date: GATE3_DATE, created: 2, skipped: 0 });
    const again = await app.inject({ method: 'POST', url: '/api/publish-sync', payload: { date: GATE3_DATE } });
    expect(again.json()).toEqual({ date: GATE3_DATE, created: 0, skipped: 2 });
    await app.close();
    await close();
  });

  it('GET /api/publish：队列在前（pending），台账在后（published）；含建议时段与草稿', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await publishReadyRepo();
    await syncPublishQueue({ repo, date: GATE3_DATE });
    const { app, close } = await buildServer(repo);
    const res = await app.inject({ method: 'GET', url: `/api/publish?date=${GATE3_DATE}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.date).toBe(GATE3_DATE);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].record.status).toBe('pending');
    expect(body.items[0].suggestedSlots.length).toBeGreaterThan(0);
    expect(body.items[0].draft.externalId).toBe('A');
    expect(body.items[0]).toHaveProperty('overdue', false);
    expect((await repo.getPublishRecords(GATE3_DATE)).filter((r) => r.status === 'pending')).toHaveLength(2);
    await app.close();
    await close();
  });

  it('POST /api/published：回填台账（url/AI 标注）→ 记录变 published；重复回填 → 409', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await publishReadyRepo();
    await syncPublishQueue({ repo, date: GATE3_DATE });
    const { app, close } = await buildServer(repo);
    const res = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: {
        date: GATE3_DATE,
        externalId: 'A',
        platform: 'xiaohongshu',
        url: 'https://www.xiaohongshu.com/note/abc123',
        aiLabeled: true,
        publishedAt: '2026-01-06T21:00:00+08:00',
      },
    });
    expect(res.statusCode).toBe(200);
    const rec = res.json().record;
    expect(rec.status).toBe('published');
    expect(rec.url).toBe('https://www.xiaohongshu.com/note/abc123');
    expect(rec.aiLabeled).toBe(true);

    // 队列视图：published 排后
    const list = (await app.inject({ method: 'GET', url: `/api/publish?date=${GATE3_DATE}` })).json();
    expect(list.items.map((i: { record: { status: string } }) => i.record.status)).toEqual(['pending', 'published']);

    const again = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: { date: GATE3_DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/note/other' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('已回填');
    await app.close();
    await close();
  });

  it('POST /api/published：未确认草稿 → 409；无队列记录 → 409 中文指引', async () => {
    delete process.env.GWD_API_TOKEN;
    const repo = await publishReadyRepo(); // B 未确认，且未 sync
    const { app, close } = await buildServer(repo);
    const notConfirmed = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: { date: GATE3_DATE, externalId: 'B', platform: 'douyin', url: 'https://v.douyin.com/xyz' },
    });
    expect(notConfirmed.statusCode).toBe(409);
    expect(notConfirmed.json().error).toContain('仅门③ 已确认');

    const noRecord = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: { date: GATE3_DATE, externalId: 'A', platform: 'douyin', url: 'https://v.douyin.com/xyz' },
    });
    expect(noRecord.statusCode).toBe(409);
    expect(noRecord.json().error).toContain('publish-sync');
    await app.close();
    await close();
  });

  it('GET /api/publish：空日期 → 200 空列表；坏日期 / 非字符串 date → 400', async () => {
    delete process.env.GWD_API_TOKEN;
    const { app, close } = await buildServer(await publishReadyRepo());
    const empty = await app.inject({ method: 'GET', url: '/api/publish?date=2026-02-01' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/publish?date=2026-13-45' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/publish-sync', payload: { date: ['2026-01-05'] } })).statusCode,
    ).toBe(400);
    await app.close();
    await close();
  });

  it('配置 token：发布三个端点同样受鉴权保护', async () => {
    process.env.GWD_API_TOKEN = 'secret-token';
    const { app, close } = await buildServer(await publishReadyRepo());
    expect((await app.inject({ method: 'GET', url: `/api/publish?date=${GATE3_DATE}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/publish-sync', payload: {} })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/published', payload: { externalId: 'A', platform: 'douyin', url: 'https://v.douyin.com/x' } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/api/publish?date=${GATE3_DATE}`, headers: { 'x-api-token': 'secret-token' } })).statusCode,
    ).toBe(200);
    await app.close();
    await close();
  });
});
