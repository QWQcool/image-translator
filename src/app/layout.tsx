import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '图译空间 · 图片分组与文字标注',
  description: '收集图片、归入空间、在图上框选区域填写文字，并导出坐标与内容',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
