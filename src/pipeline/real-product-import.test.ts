/**
 * 商品层真实数据通道（模块④ V3）测试：字段映射 / 金额清洗 / 空值边界 /
 * 表头校验 / 幂等落库 / source 类型锁死（红线：商品层只有真实通道）/
 * 按品汇总 / 端到端（临时 CSV）。断言契约不断言文案。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRepo } from '../db/memory-repo.js';
import { cleanMoney } from '../core/text-clean.js';
import {
  parseRealProductRecord,
  runRealProductImport,
  REAL_PRODUCT_SOURCE,
  validateProductHeaders,
  unknownProductHeaders,
} from './real-product-import.js';
import { REAL_PRODUCT_DISCLAIMER, runRealProductList } from './real-product-list.js';

const PRODUCT_CSV = [
  '商品ID,日期,商品标题,类目,点击数,加购数,成交订单数,成交金额（元）,佣金（元）',
  'demo-product-001,2026-11-01,加绒卫衣女宽松秋冬,服饰·女装,"1,520",180,12,"1,234.50","271.59"',
  'demo-product-001,2026-11-02,加绒卫衣女宽松秋冬,服饰·女装,1300,152,9,720.00,158.40',
  'demo-product-002,2026-11-01,免洗护发精油小样,美妆·护发,880,64,5,199.00,35.82',
].join('\n');

describe('cleanMoney（金额清洗）', () => {
  it('容忍千分位 / ￥ 前缀，四舍五入到分', () => {
    expect(cleanMoney('1,234.50')).toBe(1234.5); // CSV 引号由 csv-parse 剥，这里只测千分位
    expect(cleanMoney('￥960.00')).toBe(960);
    expect(cleanMoney('¥0.005')).toBe(0.01);
  });

  it('缺失 → 0；负数 / 非数字 / 溢出 → null（金额不猜）', () => {
    expect(cleanMoney(undefined)).toBe(0);
    expect(cleanMoney('')).toBe(0);
    expect(cleanMoney('-1.00')).toBeNull();
    expect(cleanMoney('abc')).toBeNull();
    expect(cleanMoney('1e400')).toBeNull(); // 溢出为 Infinity
  });
});

describe('表头校验', () => {
  it('必填齐全 → null', () => {
    expect(validateProductHeaders(['商品ID', '日期', '加购数'])).toBeNull();
  });

  it('缺必填 → 报缺失列名', () => {
    expect(validateProductHeaders(['日期'])).toMatch(/商品ID/);
    expect(validateProductHeaders([])).toMatch(/商品ID/);
  });

  it('未知表头提示（不阻断）', () => {
    expect(unknownProductHeaders(['商品ID', '日期', '自造列'])).toEqual(['自造列']);
    expect(unknownProductHeaders(['商品ID', '日期', '成交金额（元）', '佣金（元）'])).toEqual([]);
  });
});

describe('parseRealProductRecord（字段映射 + 空值边界）', () => {
  function rec(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      商品ID: 'demo-product-001',
      日期: '2026-11-01',
      商品标题: '加绒卫衣女宽松秋冬',
      类目: '服饰·女装',
      点击数: '1520',
      加购数: '180',
      成交订单数: '12',
      '成交金额（元）': '960.00',
      '佣金（元）': '211.20',
      ...overrides,
    };
  }

  it('完整映射：source=manual、千分位、金额到分', () => {
    const row = parseRealProductRecord(rec({ 点击数: '1,520', '成交金额（元）': '1,234.50' }))!;
    expect(row.source).toBe(REAL_PRODUCT_SOURCE); // 红线：source 强制 manual
    expect(row.clickCnt).toBe(1520);
    expect(row.gmvAmount).toBe(1234.5);
    expect(row.commissionAmount).toBe(211.2);
    expect(row.productTitle).toBe('加绒卫衣女宽松秋冬');
  });

  it('可选列全缺 → null / 0（不编造）', () => {
    const row = parseRealProductRecord({ 商品ID: 'p1', 日期: '2026-11-01' })!;
    expect(row.productTitle).toBeNull();
    expect(row.category).toBeNull();
    expect(row.clickCnt).toBe(0);
    expect(row.orderCnt).toBe(0);
    expect(row.gmvAmount).toBe(0);
    expect(row.commissionAmount).toBe(0);
  });

  it('缺关键列（商品ID / 坏日期）→ null 计 invalid', () => {
    expect(parseRealProductRecord(rec({ 商品ID: '' }))).toBeNull();
    expect(parseRealProductRecord(rec({ 日期: '11月1日' }))).toBeNull();
  });

  it('非法计数或金额（负数/非数字）→ 整行作废，不猜', () => {
    expect(parseRealProductRecord(rec({ 加购数: '-1' }))).toBeNull();
    expect(parseRealProductRecord(rec({ 成交订单数: 'abc' }))).toBeNull();
    expect(parseRealProductRecord(rec({ '成交金额（元）': '-9.9' }))).toBeNull();
    expect(parseRealProductRecord(rec({ '佣金（元）': 'NaN' }))).toBeNull();
  });
});

describe('runRealProductImport 端到端 + 按品汇总（临时文件）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeCsv(content = PRODUCT_CSV): string {
    const d = mkdtempSync(join(tmpdir(), 'gwd-rpi-'));
    dirs.push(d);
    const f = join(d, 'products.csv');
    writeFileSync(f, content, 'utf8');
    return f;
  }

  it('导入 → 落库 → 重跑全跳过（幂等）', async () => {
    const repo = new MemoryRepo();
    const file = makeCsv();
    const first = await runRealProductImport({ repo, file });
    expect(first.total).toBe(3);
    expect(first.inserted).toBe(3);
    expect(first.invalid).toBe(0);
    expect(first.productCount).toBe(2);
    expect(first.dateFrom).toBe('2026-11-01');
    expect(first.dateTo).toBe('2026-11-02');

    const second = await runRealProductImport({ repo, file });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
  });

  it('无效行计 invalid 不阻断（缺商品ID + 坏日期 + 负金额）', async () => {
    const csv = [
      '商品ID,日期,加购数,成交金额（元）',
      ',2026-11-01,10,100',
      'p1,11月1日,10,100',
      'p1,2026-11-01,10,-100',
      'p1,2026-11-01,10,100',
    ].join('\n');
    const repo = new MemoryRepo();
    const result = await runRealProductImport({ repo, file: makeCsv(csv) });
    expect(result.total).toBe(4);
    expect(result.invalid).toBe(3);
    expect(result.inserted).toBe(1);
  });

  it('缺必填表头整文件拒收（错列早失败）', async () => {
    const csv = ['product,date,cart', 'p1,2026-11-01,10'].join('\n');
    const repo = new MemoryRepo();
    await expect(runRealProductImport({ repo, file: makeCsv(csv) })).rejects.toThrow(/缺少必填表头/);
    expect((await repo.listProductPerformance('manual', 10)).length).toBe(0); // 一行都没落
  });

  it('按品汇总：成交降序 / 标题取最新非空 / 金额累计到分', async () => {
    const repo = new MemoryRepo();
    await runRealProductImport({ repo, file: makeCsv() });
    const summary = await repo.listProductPerformance('manual', 20);
    expect(summary).toHaveLength(2);
    // p001：1234.50 + 720 = 1954.50；p002：199 → p001 排前
    expect(summary[0]!.productId).toBe('demo-product-001');
    expect(summary[0]!.gmvAmount).toBe(1954.5);
    expect(summary[0]!.commissionAmount).toBe(429.99); // 271.59 + 158.40
    expect(summary[0]!.addCartCnt).toBe(332);
    expect(summary[0]!.statDays).toBe(2);
    expect(summary[0]!.productTitle).toBe('加绒卫衣女宽松秋冬');
    expect(summary[1]!.productId).toBe('demo-product-002');
  });

  it('标题后补：汇总取数据日内最新非空值（缺失日不抹掉已有标题）', async () => {
    const repo = new MemoryRepo();
    await repo.upsertProductStats([
      { source: 'manual', productId: 'p1', statDate: '2026-11-01', productTitle: '旧标题', category: 'A', clickCnt: 1, addCartCnt: 1, orderCnt: 1, gmvAmount: 10, commissionAmount: 1 },
      { source: 'manual', productId: 'p1', statDate: '2026-11-03', productTitle: null, category: null, clickCnt: 1, addCartCnt: 1, orderCnt: 1, gmvAmount: 10, commissionAmount: 1 },
    ]);
    const [s] = await repo.listProductPerformance('manual', 10);
    expect(s!.productTitle).toBe('旧标题'); // 11-03 标题缺失，不回退成 null
    expect(s!.statDays).toBe(2);
  });

  it('单品日序列按日期升序（下钻入口）', async () => {
    const repo = new MemoryRepo();
    await runRealProductImport({ repo, file: makeCsv() });
    const rows = await repo.getProductStats('manual', 'demo-product-001');
    expect(rows.map((r) => r.statDate)).toEqual(['2026-11-01', '2026-11-02']);
  });

  it('一览空数据 → 引导先导入（带真实声明）', async () => {
    const repo = new MemoryRepo();
    await expect(runRealProductList({ repo })).rejects.toThrow(/先执行 gwd real-product-import/);
    await runRealProductImport({ repo, file: makeCsv() });
    const result = await runRealProductList({ repo });
    expect(result.disclaimer).toBe(REAL_PRODUCT_DISCLAIMER);
    expect(result.summary[0]!.productId).toBe('demo-product-001');
  });

  it('limit 截断读取行数 / 缺文件与空文件抛错 / 未知表头提示', async () => {
    const repo = new MemoryRepo();
    expect((await runRealProductImport({ repo, file: makeCsv(), limit: 1 })).total).toBe(1);
    await expect(runRealProductImport({ repo, file: 'not-exist.csv' })).rejects.toThrow(/找不到 CSV 文件/);
    await expect(runRealProductImport({ repo, file: makeCsv('') })).rejects.toThrow(/CSV 是空的/);
    const r = await runRealProductImport({ repo, file: makeCsv('商品ID,日期,备注列\np1,2026-11-01,x') });
    expect(r.unknown).toEqual(['备注列']);
  });
});
