import { describe, expect, it } from 'vitest';
import { checkGates } from './gates.js';
import { RULE_V1 } from './rule-config.js';
import type { ProductSnapshot } from './types.js';

function snap(overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    externalId: 'P1',
    title: '测试商品',
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

describe('六条硬性门槛', () => {
  it('全部达标 → 全 pass', () => {
    const results = checkGates(snap(), RULE_V1);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it.each([
    ['好评率 84.9 → fail', { reviewRate: 84.9 }, 'review_rate'],
    ['佣金 15.0 → fail（严格大于）', { commissionRate: 15.0 }, 'commission'],
    ['佣金 15.01 → pass', { commissionRate: 15.01 }, null],
    ['体验分 69 → fail', { merchantScore: 69 }, 'merchant_score'],
    ['品退率 11 → fail', { returnRate: 11 }, 'return_rate'],
    ['类目含"食品" → fail', { category: '进口食品零食' }, 'category'],
    ['履约含"预售" → fail', { fulfillment: '预售长周期' }, 'fulfillment'],
    ['履约"货到付款" → fail', { fulfillment: '货到付款' }, 'fulfillment'],
  ] as const)('%s', (_name, overrides, expectedFailCode) => {
    const results = checkGates(snap(overrides as Partial<ProductSnapshot>), RULE_V1);
    const failed = results.filter((r) => r.status === 'fail').map((r) => r.code);
    if (expectedFailCode == null) {
      expect(failed).toEqual([]);
    } else {
      expect(failed).toContain(expectedFailCode);
    }
  });

  it('字段缺失 → unknown（不编数据）', () => {
    const results = checkGates(snap({ returnRate: null, reviewRate: null }), RULE_V1);
    const unknown = results.filter((r) => r.status === 'unknown').map((r) => r.code);
    expect(unknown).toContain('return_rate');
    expect(unknown).toContain('review_rate');
    expect(results.some((r) => r.status === 'fail')).toBe(false);
  });
});
