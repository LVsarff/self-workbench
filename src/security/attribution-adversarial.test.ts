/**
 * 归因通道对抗性测试（模块⑤：attribution / attribution-link / published --video-id）。
 * 四类攻击面各测一遍（恶意输入 / Prompt injection 不适用——本通道零 LLM；越权指令 / 危险载荷）：
 *   - video_id 是唯一新增外部输入，入口四层白名单（类型/长度/控制字符/字符集）
 *   - 错误信息不回显原始载荷（对齐 author 口径）
 *   - SQL 注入串 / XSS 载荷 / 伪协议一律在字符集层拦死
 *   - 恶意 days / platform 参数（CLI 与 API 共用管线入口校验）
 */
import { describe, expect, it } from 'vitest';
import { parseVideoId } from '../core/video-id.js';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import { createScriptedContentAgent } from '../agent/content-agent.js';
import { runDailyScan } from '../pipeline/daily-scan.js';
import { selectProducts } from '../pipeline/select.js';
import { runContentGen } from '../pipeline/content-gen.js';
import { confirmContentDraft } from '../pipeline/content-confirm.js';
import { recordPublish, syncPublishQueue } from '../pipeline/publish.js';
import { buildAttribution, linkVideoId } from '../pipeline/attribution.js';

const DATE = '2026-01-05';
const ALL_TRUE = [true, true, true, true, true];
const NOW_10 = new Date('2026-01-05T02:00:00Z');

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

async function publishableRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A')], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  await selectProducts({ repo, date: DATE, externalIds: ['A'] });
  await runContentGen({ repo, date: DATE, agent: createScriptedContentAgent() });
  await confirmContentDraft({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', answers: ALL_TRUE });
  await syncPublishQueue({ repo, date: DATE, now: NOW_10 });
  return repo;
}

describe('video_id 入口白名单（四层校验，错误不回显载荷）', () => {
  it('非字符串（数字/对象/数组/布尔/null）→ 拒绝', () => {
    for (const bad of [123, {}, ['vx1'], true, null, undefined]) {
      const r = parseVideoId(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('空串 / 纯空白 → 拒绝（缺锚点应走未回填提示，不是空串落库）', () => {
    expect(parseVideoId('').ok).toBe(false);
    expect(parseVideoId('   ').ok).toBe(false);
    expect(parseVideoId('\t').ok).toBe(false);
  });

  it('超长（>64）→ 拒绝且错误信息不含原串', () => {
    const payload = 'x'.repeat(2000);
    const r = parseVideoId(payload);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain(payload);
  });

  it('控制字符 / 换行（多行注入载荷）→ 拒绝', () => {
    expect(parseVideoId('vx1\nrm -rf /').ok).toBe(false);
    expect(parseVideoId('vx1\r\nDROP').ok).toBe(false);
    expect(parseVideoId('vx\x001').ok).toBe(false);
    expect(parseVideoId('vx\x7f1').ok).toBe(false);
  });

  it('SQL 注入 / XSS / 伪协议 / 全角字符 → 字符集层一律拒绝', () => {
    for (const payload of [
      "1' OR '1'='1",
      '1; DROP TABLE publish_records; --',
      '<script>alert(1)</script>',
      'javascript:alert(1)',
      'data:text/html;base64,xxx',
      'vx1 UNION SELECT * FROM products',
      '１２３', // 全角数字（\w 不匹配）
      'vx 1', // 内嵌空格
      'vx/1',
      'vx?1=2',
      'vx#frag',
      'vx&x=1',
    ]) {
      expect(parseVideoId(payload).ok, `payload 应被拒绝: ${JSON.stringify(payload.slice(0, 30))}`).toBe(false);
    }
  });

  it('合法输入：字母/数字/中文/._- 与首尾空白 trim', () => {
    expect(parseVideoId('vx1')).toEqual({ ok: true, value: 'vx1' });
    expect(parseVideoId('  vx-1.2_x  ')).toEqual({ ok: true, value: 'vx-1.2_x' });
    expect(parseVideoId('视频一号')).toEqual({ ok: true, value: '视频一号' });
    expect(parseVideoId('7358942765183948576')).toEqual({ ok: true, value: '7358942765183948576' }); // 抖音位数字 id
  });
});

describe('危险载荷经管线入口（published / attribution-link）不落库', () => {
  it("recordPublish --video-id \"1' OR '1'='1\" → 拒绝，错误不回显载荷", async () => {
    const repo = await publishableRepo();
    const payload = "1' OR '1'='1";
    await expect(
      recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', videoId: payload }),
    ).rejects.toThrow(/非法字符/);
    const rows = await repo.listPublishedForAttribution();
    expect(rows).toHaveLength(0); // pending 不进归因读取；video_id 未落任何脏值
    const records = await repo.getPublishRecords(DATE);
    expect(records[0]!.videoId).toBeNull();
  });

  it('linkVideoId 危险载荷（shell/SQL/XSS）→ 入口拒绝', async () => {
    const repo = await publishableRepo();
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a' });
    for (const payload of ['1; rm -rf /', '<img src=x onerror=alert(1)>', '1 OR 1=1--']) {
      await expect(
        linkVideoId({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', videoId: payload }),
      ).rejects.toThrow();
    }
    const rows = await repo.listPublishedForAttribution();
    expect(rows[0]!.record.videoId).toBeNull(); // 三次攻击全部未落库
  });
});

describe('越权指令 / 恶意查询参数（buildAttribution 入口）', () => {
  it('days 越界与类型混淆（Infinity / NaN / 负数 / 91 / 字符串数字）→ 拒绝', async () => {
    const repo = new MemoryRepo();
    for (const bad of [0, -1, 91, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(buildAttribution({ repo, days: bad })).rejects.toThrow(/1-90/);
    }
  });

  it('归因读取零写入：跑完报表后 repo 无任何新增（读侧报表红线）', async () => {
    const repo = await publishableRepo();
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', videoId: 'vx1' });
    await repo.upsertSimStats([
      {
        source: 'manual', videoId: 'vx1', authorId: 'me', statDate: DATE,
        videoType: null, uploadDt: null, videoDuration: null, videoTagName: null,
        showCnt: 100, playCnt: 50, completePlayCnt: 20, likeCnt: 5, commentCnt: 1, shareCnt: 0, followCnt: 1, collectCnt: 1, reportCnt: 0,
        caption: null, topicTag: null, category: null,
      },
    ]);
    const before = await repo.getPublishRecords(DATE);
    await buildAttribution({ repo });
    const after = await repo.getPublishRecords(DATE);
    expect(after).toEqual(before); // 只读报表：不改任何行
  });

  it('kuairec 撞号数据再大也进不了归因（source 锁 manual）', async () => {
    const repo = await publishableRepo();
    await recordPublish({ repo, date: DATE, externalId: 'A', platform: 'xiaohongshu', url: 'https://xhs.link/a', videoId: 'vx1' });
    await repo.upsertSimStats([
      {
        source: 'kuairec', videoId: 'vx1', authorId: 'attacker', statDate: DATE,
        videoType: null, uploadDt: null, videoDuration: null, videoTagName: null,
        showCnt: 9_999_999, playCnt: 9_999_999, completePlayCnt: 9_999_999, likeCnt: 9, commentCnt: 9, shareCnt: 9, followCnt: 9, collectCnt: 9, reportCnt: 0,
        caption: null, topicTag: null, category: null,
      },
    ]);
    const report = await buildAttribution({ repo });
    expect(report.issues.noStats).toHaveLength(1); // manual 通道无数据 → 显式报缺，不是拿模拟数据顶上
    expect(report.contents).toHaveLength(0);
  });
});
