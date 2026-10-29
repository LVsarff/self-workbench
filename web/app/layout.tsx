import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI 带货工作台 · 勾选门',
  description: '今日候选清单 —— 人只做勾选',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
