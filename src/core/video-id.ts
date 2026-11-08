/**
 * video_id 入口校验（模块⑤ 归因 join 锚点）：publish_records.video_id 的唯一写入口。
 * 口径对齐 author 四层校验（类型 / 长度 ≤64 / 控制字符 / 字符集）——
 * video_id 是外部可控输入（平台标识字符串），进 SQL join 前必须白名单化：
 *   - 非字符串（数组/对象/数字）→ 拒绝（防 .map 之类原型链把戏）
 *   - 空串 / 纯空白 → 拒绝（缺锚点应走「未回填」提示，不是空串落库）
 *   - >64 字符 → 拒绝
 *   - 控制字符 / 换行 → 拒绝（多行注入载荷）
 *   - 字符集白名单：字母/数字/中文/._-（SQL 注入与 XSS 载荷一律不通过）
 */

export const VIDEO_ID_RE = /^[\w\u4e00-\u9fff.-]+$/;

export type VideoIdParseResult = { ok: true; value: string } | { ok: false; error: string };

/** 校验并规整 video_id（trim 两端空白）。错误信息不含原值（不回显注入串，对齐 author 口径）。 */
export function parseVideoId(raw: unknown): VideoIdParseResult {
  if (typeof raw !== 'string') return { ok: false, error: 'videoId 参数无效（只接受单个字符串）' };
  const v = raw.trim();
  if (v.length === 0) return { ok: false, error: 'videoId 不能为空' };
  if (v.length > 64) return { ok: false, error: `videoId 过长（${v.length} 字符，上限 64）` };
  if (/[\u0000-\u001f\u007f]/.test(v)) return { ok: false, error: 'videoId 含非法控制字符' };
  if (!VIDEO_ID_RE.test(v)) return { ok: false, error: 'videoId 含非法字符（仅限字母/数字/中文/._-）' };
  return { ok: true, value: v };
}
