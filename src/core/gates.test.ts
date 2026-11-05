import { describe, expect, it } from 'vitest';
import { checkGates } from './gates.js';
import { RULE_V1, parseRuleConfig } from './rule-config.js';
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

  it('品退率分类目基准：命中关键词走类目阈值，未命中走默认', () => {
    // 家居收纳（无基准）12% > 默认 10% → fail
    const home = checkGates(snap({ returnRate: 12 }), RULE_V1).find((r) => r.code === 'return_rate')!;
    expect(home.status).toBe('fail');
    // 服饰内衣（基准 15%）12% → pass，detail 标注所用基准
    const apparel = checkGates(snap({ returnRate: 12, category: '服饰内衣/女装' }), RULE_V1).find(
      (r) => r.code === 'return_rate',
    )!;
    expect(apparel.status).toBe('pass');
    expect(apparel.detail).toContain('服饰');
    // 服饰内衣 15.1% > 基准 15% → fail
    const apparelFail = checkGates(snap({ returnRate: 15.1, category: '服饰内衣/女装' }), RULE_V1).find(
      (r) => r.code === 'return_rate',
    )!;
    expect(apparelFail.status).toBe('fail');
    expect(apparelFail.detail).toContain('基准 15%');
    // 类目缺失 → 默认阈值
    const noCategory = checkGates(snap({ category: null, returnRate: 11 }), RULE_V1).find(
      (r) => r.code === 'return_rate',
    )!;
    expect(noCategory.status).toBe('fail');
    expect(noCategory.detail).toBe('11% > 10%');
  });

  it('旧版规则（无基准表）仍按统一阈值解析，不炸存量版本', () => {
    const legacy = structuredClone(RULE_V1);
    delete legacy.gates.categoryReturnRateBenchmarks;
    const apparel = checkGates(snap({ returnRate: 12, category: '服饰内衣/女装' }), legacy).find(
      (r) => r.code === 'return_rate',
    )!;
    expect(apparel.status).toBe('fail');
    expect(apparel.detail).toBe('12% > 10%');
  });
});

describe('品退率基准表配置校验', () => {
  it('基准阈值超 100 或关键词重复 → 拒绝', () => {
    const bad1 = structuredClone(RULE_V1);
    bad1.gates.categoryReturnRateBenchmarks = [{ keyword: '服饰', maxReturnRate: 101 }];
    bad1.version = 99;
    expect(parseRuleConfig(bad1).ok).toBe(false);

    const bad2 = structuredClone(RULE_V1);
    bad2.gates.categoryReturnRateBenchmarks = [
      { keyword: '服饰', maxReturnRate: 15 },
      { keyword: '服饰', maxReturnRate: 12 },
    ];
    bad2.version = 99;
    const r = parseRuleConfig(bad2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('重复'))).toBe(true);
  });

  it('含合法基准表的配置可解析', () => {
    const ok = parseRuleConfig(RULE_V1);
    expect(ok.ok).toBe(true);
  });
});
