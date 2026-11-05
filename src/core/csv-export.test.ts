import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, sanitizeCsvCell } from './csv-export.js';

describe('sanitizeCsvCell：CSV 公式注入消毒（P2 修复 #3）', () => {
  it('=/+/-/@/Tab/CR 开头的文本 → 前置单引号，内容不丢', () => {
    expect(sanitizeCsvCell('=HYPERLINK("http://evil","领奖励")')).toBe("'=HYPERLINK(\"http://evil\",\"领奖励\")");
    expect(sanitizeCsvCell('+SUM(A1:A9)')).toBe("'+SUM(A1:A9)");
    expect(sanitizeCsvCell('-2+3+cmd|"/c calc"')).toBe("'-2+3+cmd|\"/c calc\"");
    expect(sanitizeCsvCell('@SUM(1+1)')).toBe("'@SUM(1+1)");
    expect(sanitizeCsvCell('\t=1+1')).toBe("'\t=1+1");
    expect(sanitizeCsvCell('\r=1+1')).toBe("'\r=1+1");
  });

  it('正常文本与空串不动（负号在中间的文本也不误伤）', () => {
    expect(sanitizeCsvCell('正常商品标题')).toBe('正常商品标题');
    expect(sanitizeCsvCell('价格- 促销')).toBe('价格- 促销');
    expect(sanitizeCsvCell('')).toBe('');
  });
});

describe('csvCell：序列化', () => {
  it('number 原样、null/undefined 空串、string 消毒+转义', () => {
    expect(csvCell(39.9)).toBe('39.9');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('含"引号')).toBe('"含""引号"'); // 内部引号翻倍
    expect(csvCell('=cmd')).toBe("'=cmd");
    // 消毒后的危险前缀在 Excel 中显示为字面 '=cmd，数据不丢
    expect(csvCell('=pdated\r\ninjected')).toBe('"\'=pdated\r\ninjected"');
  });
});

describe('buildCsv：组装', () => {
  it('BOM 头 + CRLF 行分隔 + 表头行', () => {
    const csv = buildCsv(['列A', '列B'], [['x', 1], ['y', 2]]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('列A,列B\r\nx,1\r\ny,2\r\n');
  });

  it('含注入标题的行整行仍可被 CSV 解析器正确切分（列数不变）', () => {
    const csv = buildCsv(['标题', '分数'], [['=HYPERLINK("x","y")', 93]]);
    const body = csv.replace(/^\uFEFF/, '').split('\r\n')[1]!;
    // 去掉包裹引号后是 '=HYPERLINK("x","y")，内部引号翻倍，逗号不产生多余列
    expect(body.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).toHaveLength(2);
  });
});
