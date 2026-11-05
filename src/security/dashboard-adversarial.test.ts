/**
 * P1 看板端点 + Web 渲染层对抗测试（上线前审查）。
 * 审查结论：攻破 2 项（已修复）——
 *   ① ?author=a&author=b 数组参数 → TypeError 500，错误信息泄漏代码片段（author?.t…）
 *   ② 错误回显零校验 → 超长（1 万字符）/NUL/ANSI/SQL 串/XSS 串全量反射进响应
 * 修复 = author 入口白名单（类型/长度/控制字符/字符集四层校验，全部 400 不回显原文）。
 * 防住项（留证）：SQL 注入串不打穿数据层（MemoryRepo 过滤 / PgRepo 参数化）；
 * JSON 序列化层自动转义控制字符；Web 端 React 默认转义（静态门禁测试兜底）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../api/server.js';
import { MemoryRepo } from '../db/memory-repo.js';
import type { SimContentStatRow } from '../db/repo.js';

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

/** A1 = 合法账号（kuairec + manual 各一行），保证对照组 200 */
async function seededRepo() {
  const repo = new MemoryRepo();
  await repo.upsertSimStats([stat()]);
  await repo.upsertSimStats([stat({ source: 'manual', authorId: '我的号-01.测试' })]);
  return repo;
}

describe('P1 看板对抗：author 参数攻击面（sim 端点）', () => {
  it('对照组：合法账号（字母/中文/数字/._-）→ 200，空格被 trim', async () => {
    const { app } = await buildServer(await seededRepo());
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=A1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=%20A1%20' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/real?author=%E6%88%91%E7%9A%84%E5%8F%B7-01.%E6%B5%8B%E8%AF%95' })).statusCode).toBe(200);
    await app.close();
  });

  it('攻破修复①：数组参数 → 400（修复前 TypeError 500 + 泄漏代码片段）', async () => {
    const { app } = await buildServer(await seededRepo());
    const r = await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=a&author=b' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('只接受单个字符串');
    await app.close();
  });

  it('攻破修复②：超长 author（1 万字符）→ 400 且错误不回显原文', async () => {
    const { app } = await buildServer(await seededRepo());
    const r = await app.inject({ method: 'GET', url: `/api/dashboard/sim?author=${'A'.repeat(10000)}` });
    expect(r.statusCode).toBe(400);
    expect(r.payload).not.toContain('AAAA');
    expect((await app.inject({ method: 'GET', url: `/api/dashboard/sim?author=${'A'.repeat(65)}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/dashboard/sim?author=${'A'.repeat(64)}` })).statusCode).toBe(404); // 长度合法但账号不存在
    await app.close();
  });

  it('控制字符（NUL / ANSI 转义序列）→ 400，不进数据层不回显（边缘空白由 trim 清洗，属正常）', async () => {
    const { app } = await buildServer(await seededRepo());
    for (const enc of ['%00A1', '%1B%5B31mA1', 'A%071', 'A%0A1']) {
      const r = await app.inject({ method: 'GET', url: `/api/dashboard/sim?author=${enc}` });
      expect(r.statusCode, `author=${enc}`).toBe(400);
      expect(r.json().error).toContain('控制字符');
    }
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=A1%0A' })).statusCode).toBe(200); // 尾部换行被 trim → 合法 A1
    await app.close();
  });

  it('SQL 注入串 / XSS payload / 路径穿越 → 400（字符白名单拒绝，原文不反射）', async () => {
    const { app } = await buildServer(await seededRepo());
    for (const payload of [
      encodeURIComponent("' OR '1'='1"),
      encodeURIComponent('<script>alert(1)</script>'),
      encodeURIComponent('../../etc/passwd'),
      encodeURIComponent('A1; DROP TABLE sim_content_stats;--'),
    ]) {
      const r = await app.inject({ method: 'GET', url: `/api/dashboard/sim?author=${payload}` });
      expect(r.statusCode, `author=${payload}`).toBe(400);
      expect(r.payload).not.toContain('script');
      expect(r.payload).not.toContain('OR');
    }
    await app.close();
  });

  it('real 端点同校验（双端点一致，不留第二个入口）', async () => {
    const { app } = await buildServer(await seededRepo());
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/real?author=a&author=b' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/dashboard/real?author=${'B'.repeat(100)}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/real?author=%00x' })).statusCode).toBe(400);
    await app.close();
  });

  it('空 author / 缺省 → 走默认头部账号逻辑（不误伤正常使用）', async () => {
    const { app } = await buildServer(await seededRepo());
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim?author=%20%20' })).statusCode).toBe(200); // 全空白 trim 后 = 缺省
    expect((await app.inject({ method: 'GET', url: '/api/dashboard/sim' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('P1 Web 渲染层静态门禁（红线：不注入原始 HTML）', () => {
  /** 递归收集 web/app 下全部 .ts/.tsx 源文件 */
  function collect(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...collect(p));
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('web/app 所有源文件不使用 dangerouslySetInnerHTML / innerHTML / eval', () => {
    const files = collect(join(process.cwd(), 'web', 'app'));
    expect(files.length).toBeGreaterThan(0); // 门禁本身有效（扫描到了文件）
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} 不得使用 dangerouslySetInnerHTML`).not.toContain('dangerouslySetInnerHTML');
      expect(src, `${f} 不得使用 innerHTML`).not.toMatch(/\binnerHTML\b/);
      expect(src, `${f} 不得使用 eval`).not.toMatch(/\beval\s*\(/);
    }
  });
});
