'use client';

/**
 * 共享导航条（模块② P1：统一入口）。
 * - 纯展示，不引状态库；当前页高亮
 * - 链接均为站内硬编码 href，无动态拼接（无注入面）
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/', label: '今日总览' },
  { href: '/gate', label: '勾选门' },
  { href: '/contents', label: '内容确认' },
  { href: '/publish', label: '发布台账' },
  { href: '/dashboard', label: '数据看板' },
  { href: '/attribution', label: '归因报表' },
] as const;

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      <span className="nav-brand">AI 带货工作台</span>
      {ITEMS.map((it) => {
        const active = pathname === it.href;
        return (
          <Link key={it.href} href={it.href} className={active ? 'cur' : ''} aria-current={active ? 'page' : undefined}>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
