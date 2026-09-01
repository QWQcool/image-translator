import LibraryClient from './LibraryClient';

export const metadata = { title: '图库 · 图译空间' };

export default function LibraryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl tracking-wide text-ink-100">图库</h1>
        <p className="mt-1 text-sm text-ink-400">
          上传并管理图片素材。把图片加入空间后，即可在图上框选区域填写文字。
        </p>
      </div>
      <LibraryClient />
    </div>
  );
}
