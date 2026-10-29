import { describe, expect, it } from 'vitest';
import { parseCandidatesCsv } from './csv-import.js';

const HEADER_CN = '商品ID,标题,类目,价格,佣金率,近30天销量,环比,好评率,品退率,商家体验分,履约方式,内容友好度,竞争度,复购扩展性,主图\n';
const HEADER_EN = 'external_id,title,category,price,commission_rate,sales_30d,mom_trend,review_rate,return_rate,merchant_score,fulfillment,content_friendliness,competition,repurchase,image_url\n';

const FULL_ROW = 'P1,桌面收纳盒,家居收纳,￥39.9,25%,"3,200",上升,96%,2%,85,现货,5,4,5,https://img.example/1.jpg';

function csv(header: string, lines: string[]): string {
  return header + lines.join('\n') + '\n';
}

describe('parseCandidatesCsv：表头与字段映射', () => {
  it('中文表头全字段解析（含 ￥/%/千分位清理）', () => {
    const r = parseCandidatesCsv(csv(HEADER_CN, [FULL_ROW]));
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.externalId).toBe('P1');
    expect(row.title).toBe('桌面收纳盒');
    expect(row.category).toBe('家居收纳');
    expect(row.price).toBe(39.9);
    expect(row.commissionRate).toBe(25);
    expect(row.sales30d).toBe(3200);
    expect(row.momTrend).toBe('up');
    expect(row.reviewRate).toBe(96);
    expect(row.returnRate).toBe(2);
    expect(row.merchantScore).toBe(85);
    expect(row.fulfillment).toBe('现货');
    expect(row.contentFriendliness).toBe(5);
    expect(row.competition).toBe(4);
    expect(row.repurchase).toBe(5);
    expect(row.imageUrl).toBe('https://img.example/1.jpg');
    expect(r.stats).toEqual({ total: 1, valid: 1, skipped: 0 });
  });

  it('英文字段名表头同样可解析', () => {
    const r = parseCandidatesCsv(csv(HEADER_EN, ['P2,保温杯,厨房用品,129,30%,800,持平,90,4,80,现货,4,3,3,']));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]!.externalId).toBe('P2');
    expect(r.rows[0]!.momTrend).toBe('flat');
  });

  it('中文别名表头（商品编码/商品名/销量/体验分）', () => {
    const header = '商品编码,商品名,类目,价格,佣金,销量,趋势,好评率,品退率,体验分,履约方式,内容友好度,竞争度,复购,图片\n';
    const r = parseCandidatesCsv(csv(header, ['P3,眼罩,家纺,69,20%,900,上升,91,3,76,现货,4,3,3,']));
    expect(r.errors).toEqual([]);
    expect(r.rows[0]!.externalId).toBe('P3');
    expect(r.rows[0]!.repurchase).toBe(3);
  });
});

describe('parseCandidatesCsv：解析规则', () => {
  it('环比：上升/up/↑→up；下降/↓→down；持平/-→flat；空→null；无法识别→flat', () => {
    const lines = [
      'P1,a,家居,39.9,25%,100,上升,96,2,85,现货,5,4,5,',
      'P2,a,家居,39.9,25%,100,UP,96,2,85,现货,5,4,5,',
      'P3,a,家居,39.9,25%,100,↓,96,2,85,现货,5,4,5,',
      'P4,a,家居,39.9,25%,100,持平,96,2,85,现货,5,4,5,',
      'P5,a,家居,39.9,25%,100,-,96,2,85,现货,5,4,5,',
      'P6,a,家居,39.9,25%,100,,96,2,85,现货,5,4,5,',
      'P7,a,家居,39.9,25%,100,???乱值,96,2,85,现货,5,4,5,',
    ];
    const r = parseCandidatesCsv(csv(HEADER_CN, lines));
    const trends = r.rows.map((x) => x.momTrend);
    expect(trends).toEqual(['up', 'up', 'down', 'flat', 'flat', null, 'flat']);
  });

  it('主观档位：1-5 有效；越界/非数值 → null（不编数据）', () => {
    const lines = [
      'P1,a,家居,39.9,25%,100,上升,96,2,85,现货,9,0,abc,',
      'P2,a,家居,39.9,25%,100,上升,96,2,85,现货,3,2,1,',
    ];
    const r = parseCandidatesCsv(csv(HEADER_CN, lines));
    expect(r.rows[0]!.contentFriendliness).toBeNull();
    expect(r.rows[0]!.competition).toBeNull();
    expect(r.rows[0]!.repurchase).toBeNull();
    expect(r.rows[1]!.contentFriendliness).toBe(3);
    expect(r.rows[1]!.competition).toBe(2);
    expect(r.rows[1]!.repurchase).toBe(1);
  });

  it('缺必填字段（好评率为空）→ 整行跳过并报告', () => {
    const r = parseCandidatesCsv(csv(HEADER_CN, [FULL_ROW, 'P2,耳机,数码,99,20%,1500,上升,,3,88,现货,4,3,3,']));
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.line).toBe(3);
    expect(r.errors[0]!.message).toContain('review_rate');
    expect(r.stats).toEqual({ total: 2, valid: 1, skipped: 1 });
  });

  it('数值字段解析失败（价格非数字）→ 跳行', () => {
    const r = parseCandidatesCsv(csv(HEADER_CN, ['P1,收纳盒,家居,abc,25%,100,上升,96,2,85,现货,5,4,5,']));
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0]!.message).toContain('数值字段解析失败');
  });

  it('标题/类目等可选字段为空按 null 处理（不编数据）', () => {
    const r = parseCandidatesCsv(csv(HEADER_CN, ['P1,收纳盒,,39.9,25%,100,上升,96,,85,,5,4,5,']));
    const row = r.rows[0]!;
    expect(row.category).toBeNull();
    expect(row.returnRate).toBeNull();
    expect(row.fulfillment).toBeNull();
  });
});
