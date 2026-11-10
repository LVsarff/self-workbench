'use client';

/**
 * 日期快捷切换组件（模块② P3）：今天 / 昨天 / 上一批。
 * - 纯展示 + 回调，无业务逻辑；日期用上海时区计算（与后端 todayShanghai 口径一致）
 * - 「上一批」= 昨天（单人业务量，一天一批；若将来多批再扩展）
 */
import { useCallback, useMemo } from 'react';

/** 上海时区 YYYY-MM-DD（对齐后端 todayShanghai，避免 UTC 跨日） */
export function shanghaiDate(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
}

interface DateQuickProps {
  value: string;
  onChange: (d: string) => void;
}

export default function DateQuick({ value, onChange }: DateQuickProps) {
  const today = useMemo(() => shanghaiDate(0), []);
  const yesterday = useMemo(() => shanghaiDate(-1), []);

  const presets = useMemo(
    () => [
      { label: '今天', d: today },
      { label: '昨天', d: yesterday },
      { label: '上一批', d: yesterday },
    ],
    [today, yesterday],
  );

  const set = useCallback((d: string) => onChange(d), [onChange]);

  return (
    <span className="datequick">
      {presets.map((p) => (
        <button
          key={p.label}
          className={value === p.d ? 'on' : ''}
          onClick={() => set(p.d)}
          aria-pressed={value === p.d}
        >
          {p.label}
        </button>
      ))}
    </span>
  );
}
