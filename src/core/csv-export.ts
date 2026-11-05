/**
 * CSV 导出（P2 对抗修复 #3：CSV 公式注入消毒）。
 * 红线分两层：
 * - 库里的数据原样保留（数据不是攻击面，入口已有 sanitizeText 截断/消毒）
 * - 导出边界必须消毒：任何可能被 Excel/WPS 当公式执行的文本单元格（= + - @ / Tab / CR 开头）
 *   一律前置单引号（Excel 转义惯例），导出文件打开不执行公式。
 * 该模块是所有「导出 CSV」的唯一出口，新导出功能必须走这里（验收标准，见 real-adversarial REFEED_NOTES）。
 */

/** 会触发公式执行的危险首字符（OWASP CSV Injection 口径） */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/** 文本单元格消毒：危险首字符前置单引号；内容本身一字不丢 */
export function sanitizeCsvCell(text: string): string {
  if (text.length === 0) return text;
  const first = text[0]!;
  return FORMULA_PREFIXES.includes(first) ? `'${text}` : text;
}

/** RFC 4180 引号转义：含逗号/引号/换行的单元格加双引号包裹，内部引号翻倍 */
function quoteCell(text: string): string {
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 单元格序列化：number 原样（无数值注入面）；string 先消毒再转义；null/undefined 落空串 */
export function csvCell(value: string | number | null | undefined): string {
  if (typeof value === 'number') return String(value);
  if (value == null) return '';
  return quoteCell(sanitizeCsvCell(value));
}

export type CsvRow = Array<string | number | null | undefined>;

/**
 * 组装 CSV 文本：UTF-8 BOM 头（Excel 中文兼容）+ CRLF 行分隔（RFC 4180）。
 * 所有单元格统一过 csvCell（消毒 + 转义），调用方不允许手工拼行。
 */
export function buildCsv(columns: string[], rows: CsvRow[]): string {
  const lines = [columns.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
