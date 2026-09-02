export function originalUrl(filename: string): string {
  return `/api/media/original/${encodeURIComponent(filename)}`;
}

/** @deprecated 使用 originalUrl；保留别名以免旧调用处漏改 */
export function imageUrl(filename: string): string {
  return originalUrl(filename);
}

export function thumbUrl(thumbFilename: string | null, filename: string): string {
  return `/api/media/thumb/${encodeURIComponent(thumbFilename || filename)}`;
}

export function previewUrl(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  return `/api/media/preview/${encodeURIComponent(`${stem}.webp`)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
