/**
 * 后台导出 CSV 的统一入口清洗（真实数据通道共用，零 LLM）。
 * 从 real-import.ts 抽出共用（对抗修复回归点集中在一处维护：
 * 超长截断 / ANSI 与换行消毒 / NUL 清洗 —— 见 security/real-adversarial.test.ts REFEED_NOTES）。
 * 新增导入通道必须复用本模块（验收标准），不得各自复制一份清洗逻辑。
 */

/** 文本字段长度上限（对抗修复：超长字段资源滥用/输出污染；超限截断） */
export const FIELD_MAX_LENGTH = 1000;

/**
 * 入口消毒（对抗修复：终端输出注入）：
 * - 剥离 ANSI 转义序列（如 \u001b[31m，防止看板输出伪造）
 * - 换行折成空格（防止字段内换行伪造 CLI 后续行）
 * - 剩余 C0 控制字符与 DEL 一律去除
 * - 截断至 FIELD_MAX_LENGTH
 */
export function sanitizeText(v: string): string {
  return v
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '') // ANSI CSI 序列
    .replace(/[\r\n]+/g, ' ') // 换行 → 空格（保留可读性）
    .replace(/[\u0000-\u001f\u007f]/g, '') // 其余控制字符（含 NUL）
    .slice(0, FIELD_MAX_LENGTH);
}

/** 文本清洗：空 / 全空白 → null（不编造）；其余消毒后返回 */
export function cleanText(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const v = sanitizeText(String(raw).trim());
  return v === '' ? null : v;
}

/** 计数清洗：缺失/空 → 0；负数或非数字 → null 视为非法行（真实数据不猜） */
export function cleanCount(raw: string | undefined | null): number | null {
  const v = cleanText(raw);
  if (v == null) return 0;
  const n = Number(v.replace(/,/g, '')); // 容忍千分位（后台导出常见）
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * 金额清洗（元）：缺失/空 → 0；容忍千分位与 ￥/¥ 前缀；
 * 负数或非数字 → null 视为非法行（金额不猜，避免污染佣金对账口径）。
 * 纯小数字面量走字符串十进制半进位到分（规避 Math.round(n*100) 的双精度半分陷阱：
 * 199.005 存二进制时略小于真值，浮点四舍五入会丢分）；科学计数等其余合法数字回退浮点路径。
 * 结果两位小数，与 numeric(14,2) 对齐。
 */
export function cleanMoney(raw: string | undefined | null): number | null {
  const v = cleanText(raw);
  if (v == null) return 0;
  const s = v.replace(/[,￥¥]/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (m) {
    const frac = (m[2] ?? '').padEnd(3, '0'); // 补齐 3 位：前 2 位为分，第 3 位判进位
    let cents = Number(m[1]!) * 100 + Number(frac.slice(0, 2));
    if (frac.length >= 3 && Number(frac[2]!) >= 5) cents += 1; // 十进制半进位，不依赖浮点
    return cents / 100;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/** 'YYYY-MM-DD' 校验（真实日历日；非法返回 null） */
export function parseIsoDate(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [ys, ms, ds] = v.split('-');
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return v;
}
