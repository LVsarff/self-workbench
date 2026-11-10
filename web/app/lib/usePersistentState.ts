'use client';

/**
 * 路由记忆 hook（模块② P3）：把「日期 / 数据源」等 UI 状态持久化到 localStorage，
 * 刷新 / 重开后恢复到上次的选择。按 key 隔离，各页各存各的，互不干扰。
 *
 * 安全边界：
 * - 只存「用户自己选的 UI 偏好」（日期、数据源、窗口天数），不存任何业务数据 / 凭据
 * - 读取用 try/catch 兜底（localStorage 被禁 / 隐私模式 / 值损坏时回退默认值，绝不让页面崩）
 * - 值经 JSON 序列化，读回时做类型守卫（不是合法值就丢，回到默认）
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function usePersistentState<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  // 惰性初始化：SSR / 首渲染用默认值，避免 hydration 抖动
  const [state, setState] = useState<T>(defaultValue);
  // 标记是否已完成「从 localStorage 恢复」，避免覆盖用户在恢复前的手动输入
  const restored = useRef(false);

  // 挂载后读一次 localStorage（post-mount，与现有各页 ?date= 惯例一致）
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) {
        const parsed = JSON.parse(raw) as T;
        // 类型守卫：必须是和默认值同类型的原始值（string/number/boolean），
        // 拒绝被污染的对象 / 数组（防止 localStorage 被注入恶意结构）
        if (typeof parsed === typeof defaultValue) {
          setState(parsed);
        }
      }
    } catch {
      // localStorage 不可用或值损坏 → 忽略，保持默认
    }
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (v: T) => {
      setState(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // 写入失败（配额满 / 隐私模式）静默忽略，不影响使用
      }
    },
    [key],
  );

  return [state, set];
}
