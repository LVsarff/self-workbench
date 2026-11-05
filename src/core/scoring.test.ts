import { describe, expect, it } from 'vitest';
import { rankScored, scoreProduct } from './scoring.js';
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

const score = (o: Partial<ProductSnapshot>) => scoreProduct('prod-1', snap(o), RULE_V1);

describe('七维打分（PRD A.2 边界值）', () => {
  it('佣金率分档：30→20 / 20→15 / 16→10 / 14→0', () => {
    expect(score({ commissionRate: 30 }).scores.commission).toBe(20);
    expect(score({ commissionRate: 29.9 }).scores.commission).toBe(15);
    expect(score({ commissionRate: 16 }).scores.commission).toBe(10);
    expect(score({ commissionRate: 14 }).scores.commission).toBe(0);
  });

  it('需求分档：1000+上升→20 / 1000持平→15 / 500→15 / 100→10 / 50→5', () => {
    expect(score({ sales30d: 1000, momTrend: 'up' }).scores.demand).toBe(20);
    expect(score({ sales30d: 1500, momTrend: 'flat' }).scores.demand).toBe(15);
    expect(score({ sales30d: 500, momTrend: 'up' }).scores.demand).toBe(15);
    expect(score({ sales30d: 100 }).scores.demand).toBe(10);
    expect(score({ sales30d: 99 }).scores.demand).toBe(5);
  });

  it('环比缺失按持平：1000+ 无 trend → 15 且带 flag', () => {
    const s = score({ sales30d: 1200, momTrend: null });
    expect(s.scores.demand).toBe(15);
    expect(s.flags).toContain('环比缺失按持平');
  });

  it('价格带：19.9→10 / 99→10 / 99.01→7 / 199→7 / 250→5 / 10→5', () => {
    expect(score({ price: 19.9 }).scores.price).toBe(10);
    expect(score({ price: 99 }).scores.price).toBe(10);
    expect(score({ price: 99.01 }).scores.price).toBe(7);
    expect(score({ price: 199 }).scores.price).toBe(7);
    expect(score({ price: 250 }).scores.price).toBe(5);
    expect(score({ price: 10 }).scores.price).toBe(5);
  });

  it('供应链：好评 95+→10 / 85-95→6 / <85→3；品退率高降档', () => {
    expect(score({ reviewRate: 95 }).scores.supplyChain).toBe(10);
    expect(score({ reviewRate: 90 }).scores.supplyChain).toBe(6);
    expect(score({ reviewRate: 80 }).scores.supplyChain).toBe(3);
    const capped = score({ reviewRate: 96, returnRate: 11 });
    expect(capped.scores.supplyChain).toBe(RULE_V1.scoring.highReturnRateCap);
    expect(capped.flags).toContain('品退率高供应链降档');
  });

  it('供应链降档阈值随分类目基准：服饰 12% 不降档，家居 12% 降档', () => {
    const apparel = score({ reviewRate: 96, returnRate: 12, category: '服饰内衣/女装' });
    expect(apparel.scores.supplyChain).toBe(10);
    expect(apparel.flags).not.toContain('品退率高供应链降档');
    const home = score({ reviewRate: 96, returnRate: 12, category: '家居收纳' });
    expect(home.scores.supplyChain).toBe(RULE_V1.scoring.highReturnRateCap);
    expect(home.flags).toContain('品退率高供应链降档');
  });

  it('主观三维：5/4/3 档映射', () => {
    expect(score({ contentFriendliness: 5 }).scores.contentFriendliness).toBe(15);
    expect(score({ competition: 3 }).scores.competition).toBe(10);
    expect(score({ repurchase: 1 }).scores.repurchase).toBe(2);
  });

  it('主观维缺失 → complete=false、grade=null、待评 flag，不进排序', () => {
    const s = score({ contentFriendliness: null });
    expect(s.complete).toBe(false);
    expect(s.grade).toBe(null);
    expect(s.flags.some((f) => f.startsWith('待评:'))).toBe(true);
    const { ranked } = rankScored([s]);
    expect(ranked).toHaveLength(0);
  });

  it('分级边界：80→strong / 79→test / 60→test / 59→drop', () => {
    // 构造精确总分：佣金25(15) + 销量3200up(20) + 价格39.9(10) + 好评96(10) = 55 客观分
    // 主观：cf5(15) + comp4(13) + rep5(10) = 38 → 总 93
    expect(score({}).total).toBe(93);
    expect(score({}).grade).toBe('strong');
    // comp2(8) + rep1(2) → 55+15+8+2 = 80 → strong
    expect(score({ competition: 2, repurchase: 1 }).grade).toBe('strong');
    // 再降 cf4(12) → 79 → test
    expect(score({ contentFriendliness: 4, competition: 2, repurchase: 1 }).grade).toBe('test');
    // 全 1 档：55+3+5+2 = 65 → test
    expect(score({ contentFriendliness: 1, competition: 1, repurchase: 1 }).grade).toBe('test');
    // 好评 80 → 供应链 3：48+3+5+2=58 → drop
    expect(score({ reviewRate: 80, contentFriendliness: 1, competition: 1, repurchase: 1 }).grade).toBe('drop');
  });
});

describe('排序', () => {
  it('按总分降序；门槛未过的排不进 ranked', () => {
    const a = scoreProduct('a', snap({ externalId: 'A' }), RULE_V1); // 93
    const b = scoreProduct('b', snap({ externalId: 'B', competition: 1 }), RULE_V1); // 93-13+5 = 85
    const c = scoreProduct('c', snap({ externalId: 'C', commissionRate: 10 }), RULE_V1); // 门槛淘汰
    const { ranked, pending } = rankScored([c, b, a]);
    expect(ranked.map((p) => p.snapshot.externalId)).toEqual(['A', 'B']);
    expect(pending.map((p) => p.snapshot.externalId)).toEqual(['C']);
  });
});
