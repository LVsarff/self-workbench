/**
 * 门④ Web 端点（发布队列/台账）对抗测试（上线前审查）。
 * 攻击面 = /api/publish · /api/publish-sync · /api/published 的全部外部输入：
 *   date、externalId、platform、url、publishedAt、aiLabeled。
 * 审查结论（探针实证）：
 *   - 攻破 1 项（已修复）：显式 aiLabeled: null 被静默转为 false（!= null 漏检）——AI 标注状态可被 null 置默，
 *     修复 = null 一律 400，仅 undefined 走默认 false
 *   - url 是台账渲染数据源（未来 <a href>），伪协议 = 存储型 XSS 隐患——
 *     javascript: / data: / 混淆大小写 / 控制字符 / 超 500 / 类型混淆一律 400 且不回显原文（入口白名单先于管线）
 *   - 合法 https url 带 XSS 后缀（引号/事件属性）可入库（合法输入），安全由 React 转义 + 静态门禁兜底，本测试留证
 *   - publishedAt 入口卡 ISO 日期前缀（防 '2026-2-30' 松散解析），分量非法（'2026-13-45T…'）由管线 409 终判
 *   - aiLabeled 只认布尔；类型混淆（"true" / 1）拒绝——AI 标注状态不可被字符串绕过
 *   - externalId / platform / date 沿用门③ 同款白名单（gate3-adversarial 已固化，此处抽查）
 * 防住项（留证）：pending 之外状态不可回填（409）、一条记录只回填一次（409）、token 鉴权覆盖三个端点。
 */
import { describe, expect, it } from 'vitest';
import { buildServer } from '../api/server.js';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { selectProducts } from '../pipeline/select.js';
import { runContentGen } from '../pipeline/content-gen.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { confirmContentDraft } from '../pipeline/content-confirm.js';
import { syncPublishQueue } from '../pipeline/publish.js';

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

/** A 已确认（双平台）+ 已同步队列的仓储 */
async function publishReadyRepo() {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A'), snap('B')], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A', 'B'] });
  await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform, answers: ALL_TRUE });
  }
  await syncPublishQueue({ repo, date: DATE });
  return repo;
}

function publishedPayload(overrides: Record<string, unknown> = {}) {
  return { date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/note/ok', ...overrides };
}

describe('门④ Web 对抗：url 攻击面（/api/published，台账渲染数据源）', () => {
  it('对照组：合法 https / http url 与首尾空白 → 200（trim 后入库；一平台一条，幂等不互相撞）', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    const res1 = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload() });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().record.url).toBe('https://www.xiaohongshu.com/note/ok');
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: publishedPayload({ url: 'http://v.douyin.com/abc', platform: 'douyin' }),
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().record.url).toBe('http://v.douyin.com/abc');
    await app.close();
    await close();
  });

  it('对照组延伸：首尾空白 → trim 后入库（友好输入）', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    const res = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: publishedPayload({ url: '  https://www.xiaohongshu.com/note/sp  ' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.url).toBe('https://www.xiaohongshu.com/note/sp');
    await app.close();
    await close();
  });

  it('伪协议（存储型 XSS 载荷）→ 400，原文不反射', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    const payloads = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'javascript&colon;alert(1)',
    ];
    for (const url of payloads) {
      const res = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload({ url }) });
      expect(res.statusCode, `url=${url}`).toBe(400);
      expect(res.body).not.toContain('alert');
      expect(res.body).not.toContain('script');
      expect(res.body).not.toContain('passwd');
    }
    await app.close();
    await close();
  });

  it('控制字符 / 超长（501+）/ 空串 / 纯空白 / 类型混淆 → 400', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    for (const url of ['https://a\nb', 'https://a\u0000b', `https://${'x'.repeat(501)}`, '', '   ', ['https://a'], { url: 'x' }, 42, null]) {
      const res = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload({ url }) });
      expect(res.statusCode, `url=${JSON.stringify(url)}`).toBe(400);
      expect(res.body.length).toBeLessThan(300); // 固定文案，不回显载荷
    }
    await app.close();
    await close();
  });

  it('合法 https + XSS 后缀（引号/事件属性）→ 可入库（合法输入），留证由 React 转义 + 静态门禁兜底', async () => {
    const repo = await publishReadyRepo();
    const { app, close } = await buildServer(repo);
    const tricky = 'https://evil.com/x" onmouseover="alert(1)';
    const res = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload({ url: tricky, platform: 'douyin' }) });
    expect(res.statusCode).toBe(200);
    // 台账原样存储（是合法 url 字符串）；渲染安全 = React 属性转义，web/app 静态门禁测试禁原始 HTML 注入
    const record = (await repo.getPublishRecords(DATE)).find((r) => r.url === tricky);
    expect(record?.status).toBe('published');
    await app.close();
    await close();
  });
});

describe('门④ Web 对抗：publishedAt / aiLabeled / 抽查字段', () => {
  it('publishedAt 松散格式（2026-2-30）与类型混淆 → 400；分量非法（2026-13-45T…）→ 管线 409 终判', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    for (const publishedAt of ['2026-2-30', 'not-a-date', 12345, ['2026-01-06T21:00:00'], { t: 1 }]) {
      const res = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload({ publishedAt }) });
      expect(res.statusCode, `publishedAt=${JSON.stringify(publishedAt)}`).toBe(400);
    }
    const badComponent = await app.inject({
      method: 'POST',
      url: '/api/published',
      payload: publishedPayload({ publishedAt: '2026-13-45T99:99:99+08:00', platform: 'douyin' }),
    });
    expect(badComponent.statusCode).toBe(409);
    expect(badComponent.json().error).toContain('格式无效');
    await app.close();
    await close();
  });

  it('aiLabeled 类型混淆（"true" / 1）→ 400，AI 标注状态不可被字符串绕过', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    for (const aiLabeled of ['true', 1, null, [true]]) {
      const res = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload({ aiLabeled, platform: 'douyin' }) });
      expect(res.statusCode, `aiLabeled=${JSON.stringify(aiLabeled)}`).toBe(400);
    }
    await app.close();
    await close();
  });

  it('externalId / platform / date 抽查：注入与类型混淆 → 400（与门③ 同款白名单）', async () => {
    const { app, close } = await buildServer(await publishReadyRepo());
    for (const payload of [
      publishedPayload({ externalId: "'; DROP TABLE publish_records; --" }),
      publishedPayload({ externalId: ['A'] }),
      publishedPayload({ platform: 'xhs' }),
      publishedPayload({ platform: 'douyin<script>' }),
      publishedPayload({ date: { $gt: '' } }),
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/published', payload });
      expect(res.statusCode, `payload=${JSON.stringify(payload).slice(0, 80)}`).toBe(400);
    }
    await app.close();
    await close();
  });

  it('纵深防御：重复回填 → 409（一条记录只回填一次）', async () => {
    const repo = await publishReadyRepo();
    const { app, close } = await buildServer(repo);
    expect((await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload() })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/api/published', payload: publishedPayload({ url: 'https://www.xiaohongshu.com/note/other' }) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('已回填');
    // 台账未被第二条覆盖
    const record = (await repo.getPublishRecords(DATE)).find((r) => r.platform === 'xiaohongshu')!;
    expect(record.url).toBe('https://www.xiaohongshu.com/note/ok');
    await app.close();
    await close();
  });
});
