/**
 * 门③ Web 端点对抗测试（上线前审查）。
 * 攻击面 = /api/contents · /api/confirm · /api/discard 的全部外部输入：
 *   date（query/body）、externalId（body）、platform（body）、answers（body）、note（body）。
 * 审查结论（探针实证）：
 *   - 攻破 1 项（已修复）：非字符串 date（数组/对象）被静默回退到「今天」——确认/弃用落到错误日期的语义，
 *     返回 409 而非 400；修复 = date 存在但非字符串时显式 400
 *   - externalId 入口白名单四层校验（类型/长度/控制字符/字符集），载荷一律 400 且错误不回显原文
 *   - answers 只认布尔（真值数字 1 / 字符串 "true" 均拒绝）——清单回答不可被类型混淆绕过
 *   - note 超长（1 万字）由管线截断 ≤500 后落库，响应与台账均不反射原文
 *   - banned_hits 草稿即便 answers 全 true 也 409 硬拦截（纵深防御，与 CLI 同一道闸）
 *   - 原型污染载荷不生效：JSON.parse 不触发原型写入，字段照常校验
 * 防住项（留证）：错误响应只含固定文案 + 已过白名单的输入；Web 端 React 转义（静态门禁测试兜底）。
 */
import { describe, expect, it } from 'vitest';
import { buildServer } from '../api/server.js';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ContentDraftInput } from '../db/repo.js';
import type { ProductSnapshot } from '../core/types.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { selectProducts } from '../pipeline/select.js';
import { runContentGen } from '../pipeline/content-gen.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';

const DATE = '2026-01-05';
const ALL_TRUE = [true, true, true, true, true];

function snap(externalId: string): ProductSnapshot {
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
  };
}

async function draftedRepo() {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B')], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
  await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
  return repo;
}

/** 覆盖一条草稿行，构造边界状态（banned 留痕 / needs_manual） */
async function upsertDraft(repo: MemoryRepo, externalId: string, platform: 'xiaohongshu' | 'douyin', patch: Partial<ContentDraftInput>) {
  const list = (await repo.getDailyList(DATE))!;
  const item = list.items.find((i) => i.externalId === externalId)!;
  await repo.saveContentDrafts([
    {
      runId: list.runId,
      batchDate: DATE,
      productId: item.productId,
      platform,
      status: 'draft',
      content: { title: '测试标题五个字', body: 'x'.repeat(160), tags: ['好物'], coverIdea: null },
      bannedHits: [],
      review: null,
      duplicates: [],
      revisionCount: 0,
      note: null,
      source: 'llm',
      ...patch,
    },
  ]);
}

function confirmPayload(overrides: Record<string, unknown> = {}) {
  return { date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE, ...overrides };
}

describe('门③ Web 对抗：externalId 攻击面（/api/confirm）', () => {
  it('对照组：合法 externalId（字母/中文/数字/._-）→ 走正常业务路径', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() });
    expect(res.statusCode).toBe(200);
    await app.close();
    await close();
  });

  it('类型混淆（数组 / 对象 / 数字 / null / 布尔）→ 400，不落 500', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    for (const externalId of [['A'], { id: 'A' }, 42, null, true]) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ externalId }) });
      expect(res.statusCode, `externalId=${JSON.stringify(externalId)}`).toBe(400);
      expect(res.json().error).toContain('externalId');
    }
    await app.close();
    await close();
  });

  it('注入载荷（XSS / SQL / 路径穿越 / 命令拼接）→ 400 字符集拒绝，原文不反射', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    const payloads = [
      '<img src=x onerror=alert(1)>',
      "'; DROP TABLE content_decisions; --",
      '../../etc/passwd',
      'A; rm -rf /',
      'A`$(whoami)`',
    ];
    for (const externalId of payloads) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ externalId }) });
      expect(res.statusCode, `payload=${externalId}`).toBe(400);
      const body = res.body;
      expect(body).not.toContain('onerror');
      expect(body).not.toContain('DROP TABLE');
      expect(body).not.toContain('passwd');
      expect(body).not.toContain('rm -rf');
      expect(body).not.toContain('whoami');
    }
    await app.close();
    await close();
  });

  it('控制字符（NUL / ANSI 转义）与超长（1 万字符）→ 400', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    for (const externalId of ['A\u0000B', 'A\u001b[31mB', 'A'.repeat(10000)]) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ externalId }) });
      expect(res.statusCode).toBe(400);
      expect(res.body.length).toBeLessThan(500); // 错误文案固定，不回显载荷
    }
    await app.close();
    await close();
  });

  it('空串 / 纯空白 externalId → 400（不误伤：trim 后为空即拒）', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    for (const externalId of ['', '   ']) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ externalId }) });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
    await close();
  });
});

describe('门③ Web 对抗：answers / date / note / platform 攻击面', () => {
  it('answers 类型混淆（真值数字 1 / 字符串 "true" / null）→ 400，清单回答不可绕过', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    for (const answers of [[1, 1, 1, 1, 1], ['true', 'true', 'true', 'true', 'true'], [null, null, null, null, null]]) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ answers }) });
      expect(res.statusCode, `answers=${JSON.stringify(answers)}`).toBe(400);
      expect(res.json().error).toMatch(/answers/);
    }
    await app.close();
    await close();
  });

  it('date 数组参数（query 与 body 双入口）→ 400 类型守卫，不落 500', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    const get = await app.inject({ method: 'GET', url: `/api/contents?date=${DATE}&date=2026-01-06` });
    expect(get.statusCode).toBe(400);
    const post = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ date: [DATE, '2026-01-06'] }) });
    expect(post.statusCode).toBe(400);
    const discard = await app.inject({
      method: 'POST',
      url: '/api/discard',
      payload: { date: { $gt: '' }, externalId: 'A', platform: 'douyin' },
    });
    expect(discard.statusCode).toBe(400);
    await app.close();
    await close();
  });

  it('note 超长（1 万字）→ 200 但落库被截断 ≤500，响应不反射原文', async () => {
    const repo = await draftedRepo();
    const { app, close } = await buildServer(repo);
    const huge = 'x'.repeat(10000);
    const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ note: huge }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('xxxxxxxx');
    const decisions = await repo.getContentDecisions(DATE);
    const decision = decisions.find((d) => d.action === 'confirmed')!;
    expect(decision.note!.length).toBeLessThanOrEqual(500);
    expect(decision.note!.endsWith('…[截断]')).toBe(true);
    await app.close();
    await close();
  });

  it('note 非字符串（数字 / 数组）→ 400', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    for (const note of [42, ['a']]) {
      const res = await app.inject({ method: 'POST', url: '/api/discard', payload: { date: DATE, externalId: 'A', platform: 'douyin', note } });
      expect(res.statusCode, `note=${JSON.stringify(note)}`).toBe(400);
    }
    await app.close();
    await close();
  });

  it('platform 载荷（大小写绕过 / 别名 / 注入串）→ 400 白名单', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    for (const platform of ['Xiaohongshu', 'XHS', 'xiaohongshu ', 'douyin<script>', "__proto__"]) {
      const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload({ platform }) });
      expect(res.statusCode, `platform=${platform}`).toBe(400);
    }
    await app.close();
    await close();
  });
});

describe('门③ Web 对抗：纵深防御与结构载荷', () => {
  it('banned_hits 非空草稿 + answers 全 true → 409 硬拦截（词表层与门③ 是两道闸）', async () => {
    const repo = await draftedRepo();
    await upsertDraft(repo, 'A', 'xiaohongshu', { bannedHits: ['全网第一'] });
    const { app, close } = await buildServer(repo);
    const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('硬拦截');
    expect((await repo.getContentDecisions(DATE)).filter((d) => d.action === 'confirmed')).toHaveLength(0);
    await app.close();
    await close();
  });

  it('needs_manual 草稿 + answers 全 true → 409（内容为空不能确认）', async () => {
    const repo = await draftedRepo();
    await upsertDraft(repo, 'A', 'xiaohongshu', { status: 'needs_manual', content: null });
    const { app, close } = await buildServer(repo);
    const res = await app.inject({ method: 'POST', url: '/api/confirm', payload: confirmPayload() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('内容为空');
    await app.close();
    await close();
  });

  it('原型污染载荷 → 不生效，字段照常走白名单校验', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    const res = await app.inject({
      method: 'POST',
      url: '/api/confirm',
      payload: { __proto__: { polluted: true }, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE },
    });
    // JSON.parse 不会写原型；__proto__ 字段被忽略，正常业务路径
    expect(res.statusCode).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await app.close();
    await close();
  });

  it('顶层 JSON 数组 body / 缺字段 → 400（不落 500）', async () => {
    const { app, close } = await buildServer(await draftedRepo());
    const arr = await app.inject({ method: 'POST', url: '/api/confirm', payload: ['A', 'xiaohongshu'] });
    expect(arr.statusCode).toBe(400);
    const empty = await app.inject({ method: 'POST', url: '/api/discard', payload: {} });
    expect(empty.statusCode).toBe(400);
    await app.close();
    await close();
  });
});
