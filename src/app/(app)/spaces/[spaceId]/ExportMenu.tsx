'use client';

import { useEffect, useRef, useState } from 'react';

type ExportOption = { format: string; label: string; hint: string; href?: string };

const OPTIONS: ExportOption[] = [
  { format: 'zip', label: '导出 ZIP', hint: 'JSON + CSV 打包' },
  { format: 'json', label: '导出 JSON', hint: '完整结构，含归一化与像素坐标' },
  { format: 'csv', label: '导出 CSV', hint: '表格形式，可用 Excel 打开' },
  { format: 'lp', label: '导出 翻译_0.txt', hint: 'LabelPlus / PS-Script 兼容' },
  // 官方 txt 格式走独立 route
  {
    format: 'lp-txt',
    label: 'LabelPlus 文本（PS 脚本）',
    hint: '官方 txt 格式，按文件名匹配 PSD 图层',
    href: '/labelplus-txt',
  },
];

export default function ExportMenu({
  spaceId,
  disabled,
}: {
  spaceId: number;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function importFile(file: File) {
    setImporting(true);
    setNotice(null);
    try {
      const text = await file.text();
      const res = await fetch(`/api/spaces/${spaceId}/labelplus/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? '导入失败');
        return;
      }
      setNotice(`导入 ${data.imported} 个标号，匹配 ${data.matched} 张图`);
      window.setTimeout(() => window.location.reload(), 600);
    } catch {
      setNotice('导入失败');
    } finally {
      setImporting(false);
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <input
        ref={fileRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />
      <button
        type="button"
        className="btn-ghost"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={disabled ? '空间内没有图片' : undefined}
      >
        导出 ▾
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-60 overflow-hidden rounded-lg border border-ink-700 bg-cloud shadow-card">
          {OPTIONS.map((option) => (
            <a
              key={option.format}
              href={`/api/spaces/${spaceId}${option.href ?? `/export?format=${option.format}`}`}
              onClick={() => setOpen(false)}
              className="block px-3 py-2.5 text-sm text-ink-200 transition-colors hover:bg-paper"
            >
              <div className="font-medium">{option.label}</div>
              <div className="mt-0.5 text-[11px] text-ink-500">{option.hint}</div>
            </a>
          ))}
          <button
            type="button"
            className="block w-full px-3 py-2.5 text-left text-sm text-ink-200 transition-colors hover:bg-paper"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            <div className="font-medium">{importing ? '导入中…' : '导入 翻译_0.txt'}</div>
            <div className="mt-0.5 text-[11px] text-ink-500">按文件名匹配进空间</div>
          </button>
          {notice && <p className="px-3 py-2 text-[11px] text-ink-400">{notice}</p>}
        </div>
      )}
    </div>
  );
}
