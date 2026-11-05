/**
 * 深度调研摘要（模块① V2 收官）测试：生成 / 幂等 / 边界 / 降级 / 审计 / 内容工坊注入。
 * 核心语义：摘要是参考不是事实（人终判）；原文商家可控 → 截断后进 prompt；
 * 摘要落库是内容工坊的素材源（生成时自动注入）。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { RULE_V1 } from '../core/rule-config.js';
import type { ProductSnapshot } from '../core/types.js';
import type { ContentAgent, ContentRequest, ContentAgentResult } from '../agent/content-agent.js';
import { runDailyScan } from './daily-scan.js';
import { runContentGen } from './content-gen.js';
import { runResearch, showResearch, SOURCE_TEXT_MIN } from './research.js';
import {
  buildResearchPrompt,
  clipSourceText,
  SOURCE_TEXT_MAX,
  type ResearchAgent,
} from '../agent/research-agent.js';

const DATE = '2026-01-05';

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

const SOURCE = [
  '买家A：尺寸刚好，厨房台面清爽多了，安装也简单，推荐！',
  '买家B：用了两周有点松动，客服补发了配件',
  '买家C：这个能放微波炉旁边吗？怕高温变形',
  '买家D：颜值好看，放在台面上很满意',
].join('\n');

async function scannedRepo(): Promise<MemoryRepo> {
  const repo = new MemoryRepo();
  await repo.applyRuleVersion(RULE_V1, { reason: 'init', approvedBy: 't' });
  await repo.upsertSnapshots([snap('A')], DATE);
  await runDailyScan({ repo, date: DATE, agent: null });
  return repo;
}

/** 捕获请求的假 ContentAgent（验证 research 注入） */
function spyContentAgent(): ContentAgent & { requests: ContentRequest[] } {
  const requests: ContentRequest[] = [];
  return {
    name: 'spy',
    requests,
    async generate(req) {
      requests.push(req);
      const result: ContentAgentResult = {
        xiaohongshu: {
          title: '台面收纳好物分享',
          body: '厨房台面清爽多了，安装简单，真实使用三周体验。尺寸刚好，不占地方，值得入手。',
          tags: ['收纳', '厨房好物', '居家'],
          coverIdea: null,
        },
        douyin: { hook: '厨房台面乱必看', points: ['三点讲清这个置物架'], cta: '点击评论区链接' },
        submitted: true,
        degraded: false,
        audit: { purpose: 't', model: 'spy', skill: 't', input: { prompt: 'p' }, output: {} },
      };
      return result;
    },
  };
}

describe('runResearch：生成与幂等', () => {
  it('正常生成：分类正确（好评/风险/素材点）+ 落库可查 + 审计落账', async () => {
    const repo = await scannedRepo();
    const agent = (await import('../agent/research-agent.js')).createScriptedResearchAgent();
    const result = await runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent });

    expect(result.summary.sentiment).toBe('mixed'); // 有风险信号（松动）→ mixed，无风险才是 positive
    expect(result.summary.risks).toHaveLength(1);
    expect(result.summary.risks[0]).toContain('松动');
    expect(result.summary.highlights.length).toBeGreaterThanOrEqual(1);

    const row = await repo.getResearch(result.productId);
    expect(row).not.toBeNull();
    expect(row!.summary.materialPoints.length).toBeGreaterThanOrEqual(1);
    expect(row!.sourceText).toContain('买家A');

    const logs = (repo as unknown as { llmLogs: Array<{ purpose: string; ok: boolean }> }).llmLogs;
    const mine = logs.filter((l) => l.purpose === 'research:summary');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.ok).toBe(true);
  });

  it('幂等：同品重复生成拒绝（提示 --force）；--force 覆盖（原文与摘要同换）', async () => {
    const repo = await scannedRepo();
    const agent = (await import('../agent/research-agent.js')).createScriptedResearchAgent();
    await runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent });

    await expect(runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent })).rejects.toThrow(/已有一份调研摘要.*--force/);

    const newSource = '买家E：质量很好用得开心回购了\n买家F：物流快包装完好满意\n买家G：这个尺寸是多少厘米呢\n买家H：朋友推荐来买的真不错';
    const redone = await runResearch({ repo, externalId: 'A', sourceText: newSource, agent, force: true });
    expect(redone.truncated).toBe(false);
    const row = await repo.getResearch(redone.productId);
    expect(row!.sourceText).toContain('买家E');
    expect(row!.sourceText).not.toContain('买家A');
  });

  it('showResearch：无 → null；有 → 行（CLI 查看模式）', async () => {
    const repo = await scannedRepo();
    expect(await showResearch(repo, 'A')).toBeNull();
    const agent = (await import('../agent/research-agent.js')).createScriptedResearchAgent();
    await runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent });
    const row = await showResearch(repo, 'A');
    expect(row?.summary.sentiment).toBe('mixed');
  });
});

describe('runResearch：输入边界', () => {
  const agent: ResearchAgent = {
    name: 'never',
    async summarize() {
      throw new Error('不应被调用');
    },
  };

  it('品不存在 → 抛错', async () => {
    const repo = await scannedRepo();
    await expect(runResearch({ repo, externalId: 'NOPE', sourceText: SOURCE, agent })).rejects.toThrow(/没有找到商品 NOPE/);
  });

  it('原文为空 / 纯空白 → 抛错（不调 LLM）', async () => {
    const repo = await scannedRepo();
    await expect(runResearch({ repo, externalId: 'A', sourceText: '', agent })).rejects.toThrow('原文为空');
    await expect(runResearch({ repo, externalId: 'A', sourceText: '   \n  ', agent })).rejects.toThrow('原文为空');
  });

  it('原文太短（信息量不足）→ 抛错', async () => {
    const repo = await scannedRepo();
    await expect(runResearch({ repo, externalId: 'A', sourceText: 'x'.repeat(SOURCE_TEXT_MIN - 1), agent })).rejects.toThrow(/原文太短/);
  });

  it('原文超长 → 截断存档（truncated 标记），不整段进 prompt', async () => {
    const repo = await scannedRepo();
    const scripted = (await import('../agent/research-agent.js')).createScriptedResearchAgent();
    const long = `${'买家反馈质量好满意。'.repeat(1000)}\n${'差评退货吐槽。'.repeat(1000)}`; // >17000 字，远超 8000 上限
    const result = await runResearch({ repo, externalId: 'A', sourceText: long, agent: scripted });
    expect(result.truncated).toBe(true);
    expect(result.sourceTextChars).toBeLessThanOrEqual(SOURCE_TEXT_MAX);
    const row = await repo.getResearch(result.productId);
    expect(row!.sourceText.endsWith('…[截断]')).toBe(true);
  });
});

describe('runResearch：降级与预算', () => {
  const scripted = { current: null as ResearchAgent | null };
  async function loadScripted(): Promise<ResearchAgent> {
    if (!scripted.current) scripted.current = (await import('../agent/research-agent.js')).createScriptedResearchAgent();
    return scripted.current;
  }

  it('未配置 LLM（agent null）→ 明确提示人工整理，不落任何摘要', async () => {
    const repo = await scannedRepo();
    await expect(runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent: null })).rejects.toThrow('未配置 OPENAI_API_KEY');
    const productId = await repo.findProductIdByExternalId('A');
    expect(await repo.getResearch(productId!)).toBeNull();
  });

  it('LLM 日预算用尽 → 熔断（显式人工动作也不绕预算）', async () => {
    const repo = await scannedRepo();
    const agent = await loadScripted();
    await expect(runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent, llmBudgetPerDay: 0 })).rejects.toThrow(/日预算已用尽/);
  });

  it('Agent 抛错 → 审计记失败（ok=false），异常上抛', async () => {
    const repo = await scannedRepo();
    const boom: ResearchAgent = {
      name: 'boom',
      async summarize() {
        throw new Error('LLM down');
      },
    };
    await expect(runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent: boom })).rejects.toThrow('LLM down');
    const logs = (repo as unknown as { llmLogs: Array<{ purpose: string; ok: boolean; error?: string }> }).llmLogs;
    const mine = logs.filter((l) => l.purpose === 'research:summary');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.ok).toBe(false);
    expect(mine[0]!.error).toContain('LLM down');
  });

  it('Agent 未按要求提交（degraded）→ 抛错 + 审计失败', async () => {
    const repo = await scannedRepo();
    const lazy: ResearchAgent = {
      name: 'lazy',
      async summarize() {
        return {
          summary: { sentiment: 'neutral', highlights: [], risks: [], materialPoints: [] },
          degraded: true,
          audit: { purpose: 'research:summary', model: 'lazy', skill: 'research', input: null, output: null },
        };
      },
    };
    await expect(runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent: lazy })).rejects.toThrow('未按要求提交');
  });
});

describe('内容工坊注入（消费闭环）', () => {
  it('有调研摘要的品 → content-gen 请求带 research；无摘要的品 → research 为 null', async () => {
    const repo = await scannedRepo();
    // 先给 A 生成调研摘要，再勾选 A + B（B 无摘要）对比
    await repo.upsertSnapshots([snap('B')], DATE);
    await runDailyScan({ repo, date: DATE, agent: null });
    const runId = (await repo.getDailyList(DATE))!.runId; // getDailyList 的 selected 判定要求真实 runId
    await repo.saveDecisions([{ runId, batchDate: DATE, productId: (await repo.findProductIdByExternalId('A'))!, action: 'selected', decidedBy: 't' }]);
    await repo.saveDecisions([{ runId, batchDate: DATE, productId: (await repo.findProductIdByExternalId('B'))!, action: 'selected', decidedBy: 't' }]);

    const scripted = (await import('../agent/research-agent.js')).createScriptedResearchAgent();
    await runResearch({ repo, externalId: 'A', sourceText: SOURCE, agent: scripted });

    const spy = spyContentAgent();
    await runContentGen({ repo, date: DATE, agent: spy, reviewer: null });

    const forA = spy.requests.find((r) => r.product.externalId === 'A');
    const forB = spy.requests.find((r) => r.product.externalId === 'B');
    expect(forA?.research).not.toBeNull();
    expect(forA!.research!.risks).toHaveLength(1);
    expect(forA!.research!.materialPoints!.length).toBeGreaterThanOrEqual(1);
    expect(forB?.research).toBeNull();
  });
});

describe('buildResearchPrompt：输入净化', () => {
  it('品字段 + 原文注入可见；超长原文截断标记', () => {
    const { prompt } = buildResearchPrompt({
      product: { externalId: 'A', title: '商品A', category: '家居', price: 39.9, commissionRate: 25, sales30d: 3200 },
      sourceText: 'x'.repeat(SOURCE_TEXT_MAX + 500),
    });
    expect(prompt).toContain('"external_id": "A"');
    expect(prompt).toContain('[SOURCE_TEXT]');
    expect(prompt).toContain('…[截断]');
    expect(prompt).not.toContain('x'.repeat(SOURCE_TEXT_MAX));
  });

  it('clipSourceText：上限内原样，超限截断（标记算进预算）', () => {
    const short = 'a'.repeat(100);
    expect(clipSourceText(short)).toBe(short);
    const clipped = clipSourceText('b'.repeat(SOURCE_TEXT_MAX + 100));
    expect(clipped.length).toBe(SOURCE_TEXT_MAX);
    expect(clipped.endsWith('…[截断]')).toBe(true);
  });
});
