import SpacesClient from './SpacesClient';

export const metadata = { title: '空间 · 图译空间' };

export default function SpacesPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">空间</h1>
          <p className="mt-1 text-sm text-ink-400">
            把图片按主题归入不同空间，逐个标注，最后整空间导出。
          </p>
        </div>
      </div>
      <SpacesClient />
    </div>
  );
}
