/**
 * 发布时段建议（模块③ B2）：纯静态表 + 纯代码，零 LLM。
 * 时段依据为两平台公开的流量高峰常识（午休 / 晚高峰 / 睡前），非精确数据——
 * 只做排期参考（建议层），不构成任何自动发布依据（门④ 红线）。
 * 口径可按实际账号数据调整（V3 数据监控就位后校准）。
 */
import type { Platform } from './types.js';

/** 各平台建议发布时段（上海时间 HH:mm，升序） */
export const PUBLISH_SLOTS: Record<Platform, string[]> = {
  xiaohongshu: ['12:00', '18:00', '21:00'],
  douyin: ['12:00', '18:00', '22:00'],
};

/** 距档位生效至少预留的缓冲（内容复制 / 排版 / 发布操作时间） */
const BUFFER_MINUTES = 30;

/** Asia/Shanghai 固定 UTC+8（中国无夏令时，无需 DST 处理） */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 上海时间的日期+分钟分量 */
function shanghaiParts(now: Date): { date: string; minutes: number } {
  const t = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const date = t.toISOString().slice(0, 10);
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return { date, minutes };
}

function slotToMinutes(slot: string): number {
  const [h, m] = slot.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * 下一档建议发布时间（上海时间 'YYYY-MM-DD HH:mm'）。
 * 今日档位需 ≥ now + 30 分钟缓冲才算可选；今日无可选档 → 明日第一档。
 */
export function nextPublishSlot(platform: Platform, now: Date): string {
  const slots = PUBLISH_SLOTS[platform];
  const { date, minutes } = shanghaiParts(now);
  const earliest = minutes + BUFFER_MINUTES;
  for (const slot of slots) {
    if (slotToMinutes(slot) >= earliest) return `${date} ${slot}`;
  }
  // 明日第一档：日期 +1 天（用 Date 滚动避免手写月/年末进位）
  const tomorrow = new Date(now.getTime() + SHANGHAI_OFFSET_MS + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `${tomorrow} ${slots[0]!}`;
}

/** 建议时段列表（今日剩余可选档；今日无可选档则给明日全部，最多 3 档） */
export function suggestSlots(platform: Platform, now: Date): string[] {
  const slots = PUBLISH_SLOTS[platform];
  const { date, minutes } = shanghaiParts(now);
  const earliest = minutes + BUFFER_MINUTES;
  const today = slots.filter((s) => slotToMinutes(s) >= earliest).map((s) => `${date} ${s}`);
  if (today.length > 0) return today;
  const tomorrow = new Date(now.getTime() + SHANGHAI_OFFSET_MS + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return slots.map((s) => `${tomorrow} ${s}`);
}

/** 上海时间 'YYYY-MM-DD HH:mm' → ISO 时间戳（落库用，避免 timestamptz 按连接时区误解析） */
export function shanghaiSlotToIso(slot: string): string {
  return new Date(`${slot.replace(' ', 'T')}:00+08:00`).toISOString();
}

/** ISO 时间戳 → 上海时间 'YYYY-MM-DD HH:mm'（展示用） */
export function isoToShanghaiDisplay(iso: string): string {
  return new Date(new Date(iso).getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}
