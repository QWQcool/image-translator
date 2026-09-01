'use client';

import { useEffect, useRef, useState } from 'react';

const OPTIONS = [
  { format: 'zip', label: '导出 ZIP', hint: 'JSON + CSV 打包' },
  { format: 'json', label: '导出 JSON', hint: '完整结构，含归一化与像素坐标' },
  { format: 'csv', label: '导出 CSV', hint: '表格形式，可用 Excel 打开' },
];

export default function ExportMenu({
  spaceId,
  disabled,
}: {
  spaceId: number;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
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
              href={`/api/spaces/${spaceId}/export?format=${option.format}`}
              onClick={() => setOpen(false)}
              className="block px-3 py-2.5 text-sm text-ink-200 transition-colors hover:bg-paper"
            >
              <div className="font-medium">{option.label}</div>
              <div className="mt-0.5 text-[11px] text-ink-500">{option.hint}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
