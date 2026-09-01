import type { Metadata } from 'next';
import { Noto_Sans_SC, Nunito, ZCOOL_XiaoWei } from 'next/font/google';
import './globals.css';

const display = ZCOOL_XiaoWei({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const noto = Noto_Sans_SC({
  weight: ['400', '500', '700'],
  subsets: ['latin'],
  variable: '--font-noto',
  display: 'swap',
});

const nunito = Nunito({
  subsets: ['latin'],
  variable: '--font-nunito',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '图译空间 · 图片分组与文字标注',
  description: '收集图片、归入空间、在图上框选区域填写文字，并导出坐标与内容',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className={`${display.variable} ${noto.variable} ${nunito.variable} min-h-screen`}>
        {children}
      </body>
    </html>
  );
}
