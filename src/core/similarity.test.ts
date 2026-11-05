import { describe, expect, it } from 'vitest';
import { DUPLICATE_SIMILARITY_THRESHOLD, jaccardSimilarity } from './similarity.js';

describe('jaccardSimilarity（字符 bigram）', () => {
  it('完全相同 → 1', () => {
    expect(jaccardSimilarity('今天分享一个好物', '今天分享一个好物')).toBe(1);
  });

  it('完全不同 → 0', () => {
    expect(jaccardSimilarity('苹果香蕉橘子', '桌子椅子柜子')).toBe(0);
  });

  it('空文本 → 0（不误报）', () => {
    expect(jaccardSimilarity('', '任何内容')).toBe(0);
    expect(jaccardSimilarity('', '')).toBe(0);
  });

  it('空白不影响', () => {
    expect(jaccardSimilarity('今天 分享 好物', '今天分享好物')).toBe(1);
  });

  it('换词复述 → 显著低于阈值（不误伤正常改写）', () => {
    const a = '这款保温杯316内胆，保温一整天，冬天通勤必备神器。';
    const b = '这个杯子用了316的不锈钢内胆，早上装的热水到下午还是温的。';
    expect(jaccardSimilarity(a, b)).toBeLessThan(DUPLICATE_SIMILARITY_THRESHOLD);
  });

  it('同模板换产品 → 中等重叠，仍低于阈值', () => {
    const a = '桌面收纳盒到货，来交个作业。39.9元入手，做工没有廉价感，日常场景完全够用。';
    const b = '保温杯到货，来交个作业。89元入手，做工没有廉价感，日常场景完全够用。';
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.3);
    expect(jaccardSimilarity(a, b)).toBeLessThan(DUPLICATE_SIMILARITY_THRESHOLD);
  });

  it('仅个别词不同 → 超过阈值（该触发重写）', () => {
    const a = '这款桌面收纳盒真的太好用了，桌面终于清空了，链接放评论区置顶。';
    const b = '这款桌面收纳盒真的太好用了，桌面终于干净了，链接放评论区置顶。';
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(DUPLICATE_SIMILARITY_THRESHOLD);
  });
});
