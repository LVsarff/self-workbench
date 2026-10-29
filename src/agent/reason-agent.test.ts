import { describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { RULE_V1 } from '../core/rule-config.js';
import { scoreProduct } from '../core/scoring.js';
import type { ProductSnapshot, ScoredProduct } from '../core/types.js';
import { buildAgentPrompt, createAiSdkReasonAgent, validateCollectedReasons, type ReasonRequest } from './reason-agent.js';

const RUN_ID = 'run-test-0001';

function scored(): ScoredProduct[] {
  const snap: ProductSnapshot = {
    externalId: 'P1',
    title: '桌面收纳盒（多层抽屉式）',
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
  return [scoreProduct('p1', snap, RULE_V1)];
}

function makeRequest(): ReasonRequest {
  return { runId: RUN_ID, top: scored(), rule: RULE_V1, history: [] };
}

function toolCall(toolCallId: string, toolName: string, input: unknown) {
  return { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) };
}

function step(content: ReturnType<typeof toolCall>[] | Array<{ type: 'text'; text: string }>, unified: 'tool-calls' | 'stop') {
  return {
    content,
    finishReason: { unified, raw: unified },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
  };
}

const REASON_TEXT = '佣金25%、近30天销量3200且环比上升，好评率96%，总分93分强推，适合做收纳改造开箱内容。';

describe('validateCollectedReasons：校验与丢弃', () => {
  it('引用不在 Top 候选的商品 → 丢弃（防幻觉）', () => {
    const out = validateCollectedReasons(
      [
        { productId: 'p1', text: REASON_TEXT, citedFields: ['total'] },
        { productId: 'ghost', text: REASON_TEXT, citedFields: ['total'] },
      ],
      scored(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.productId).toBe('p1');
  });

  it('理由长度越界（<20 或 >300）→ 丢弃', () => {
    const out = validateCollectedReasons(
      [
        { productId: 'p1', text: '太短', citedFields: ['total'] },
        { productId: 'p1', text: 'x'.repeat(301), citedFields: ['total'] },
      ],
      scored(),
    );
    expect(out).toHaveLength(0);
  });

  it('cited_fields 为空 → 丢弃（理由必须引用真实字段）', () => {
    const out = validateCollectedReasons([{ productId: 'p1', text: REASON_TEXT, citedFields: [] }], scored());
    expect(out).toHaveLength(0);
  });
});

describe('buildAgentPrompt：骨架 + 任务包 + 注入', () => {
  it('包含 [DATA] 标记、run_id、候选 JSON 与规则摘要', () => {
    const { system, prompt } = buildAgentPrompt(makeRequest());
    expect(system).toContain('工具契约'); // 骨架 prompt 关键节
    expect(system).toContain('save_reason'); // SKILL 任务包
    expect(prompt).toContain('## 今日输入 [DATA]');
    expect(prompt).toContain(`run_id: ${RUN_ID}`);
    expect(prompt).toContain('"external_id": "P1"');
    expect(prompt).toContain('门槛'); // 规则摘要
  });
});

describe('createAiSdkReasonAgent：工具循环（MockLanguageModelV4）', () => {
  it('正常路径：save_reason → submit_list → 文本收尾，完整产出', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        step([toolCall('c1', 'save_reason', { product_id: 'p1', text: REASON_TEXT, cited_fields: ['commission_rate', 'sales_30d', 'total'] })], 'tool-calls'),
        step([toolCall('c2', 'submit_list', { run_id: RUN_ID })], 'tool-calls'),
        step([{ type: 'text', text: '清单已提交' }], 'stop'),
      ],
    });
    const agent = createAiSdkReasonAgent({ model, modelName: 'mock' });
    const result = await agent.generate(makeRequest());

    expect(result.submitted).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]!.productId).toBe('p1');
    expect(result.reasons[0]!.citedFields).toContain('total');
    expect(result.audit.output).toMatchObject({ submitted: true, valid: 1 });
  });

  it('不提交（只 save_reason 后文本停止）→ 降级标记', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        step([toolCall('c1', 'save_reason', { product_id: 'p1', text: REASON_TEXT, cited_fields: ['total'] })], 'tool-calls'),
        step([{ type: 'text', text: '我写完了' }], 'stop'),
      ],
    });
    const agent = createAiSdkReasonAgent({ model, modelName: 'mock' });
    const result = await agent.generate(makeRequest());

    expect(result.submitted).toBe(false);
    expect(result.degraded).toBe(true); // 未走完成停止 → 流水线将模板补位
    expect(result.reasons).toHaveLength(1); // 理由本身有效，仍保留
  });

  it('submit_list 的 run_id 不匹配 → 不算提交', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        step([toolCall('c1', 'save_reason', { product_id: 'p1', text: REASON_TEXT, cited_fields: ['total'] })], 'tool-calls'),
        step([toolCall('c2', 'submit_list', { run_id: '别人的-run' })], 'tool-calls'),
        step([{ type: 'text', text: '结束' }], 'stop'),
      ],
    });
    const agent = createAiSdkReasonAgent({ model, modelName: 'mock' });
    const result = await agent.generate(makeRequest());
    expect(result.submitted).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it('步数硬限（stopWhen: stepCountIs）→ 强制停止并降级', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        step([toolCall('c1', 'save_reason', { product_id: 'p1', text: REASON_TEXT, cited_fields: ['total'] })], 'tool-calls'),
        step([toolCall('c2', 'save_reason', { product_id: 'p1', text: REASON_TEXT, cited_fields: ['total'] })], 'tool-calls'),
      ],
    });
    const agent = createAiSdkReasonAgent({ model, modelName: 'mock', maxSteps: 2 });
    const result = await agent.generate(makeRequest());

    expect(result.submitted).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.audit.output).toMatchObject({ steps: 2 }); // 恰好停在第 2 步
  });

  it('幻觉商品 ID 被 save_reason 收集但校验丢弃', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        step([toolCall('c1', 'save_reason', { product_id: 'ghost-id', text: REASON_TEXT, cited_fields: ['total'] })], 'tool-calls'),
        step([toolCall('c2', 'submit_list', { run_id: RUN_ID })], 'tool-calls'),
        step([{ type: 'text', text: '完成' }], 'stop'),
      ],
    });
    const agent = createAiSdkReasonAgent({ model, modelName: 'mock' });
    const result = await agent.generate(makeRequest());

    expect(result.reasons).toHaveLength(0); // 幻觉被丢弃
    expect(result.degraded).toBe(true); // 理由数 < Top 数 → 降级，流水线模板补位
    expect(result.audit.output).toMatchObject({ collected: 1, valid: 0 });
  });
});
