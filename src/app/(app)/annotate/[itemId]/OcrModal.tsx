'use client';

import { useState } from 'react';

export type OcrProposal = {
  x: number;
  y: number;
  box: { x: number; y: number; w: number; h: number };
  source_text: string;
  confidence: number | null;
  skipped?: boolean;
};

export default function OcrModal({
  itemId,
  onClose,
  onApplied,
}: {
  itemId: number;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<OcrProposal[]>([]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [groups, setGroups] = useState<Record<number, number>>({});

  async function detect() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/ocr`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '识别失败');
        return;
      }
      const list = (data.proposals ?? []) as OcrProposal[];
      setProposals(list);
      setPicked(new Set(list.map((_, i) => i)));
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }

  async function accept() {
    const selected = [...picked].map((index) => ({
      x: proposals[index].x,
      y: proposals[index].y,
      source_text: proposals[index].source_text,
      group_id: groups[index] ?? 1,
    }));
    if (selected.length === 0) {
      setError('请至少采纳一条');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/items/${itemId}/ocr/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposals: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存失败');
        return;
      }
      onApplied();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-100/30 p-4">
      <div className="card w-full max-w-lg p-4">
        <h2 className="font-display text-lg text-ink-100">OCR 自动标号</h2>
        <p className="mt-1 text-xs text-ink-400">
          检出结果必须勾选采纳才会写入。译文留空，不覆盖已有手标。
        </p>
        {error && <p className="notice-error mt-2">{error}</p>}
        {proposals.length === 0 ? (
          <button type="button" className="btn-primary mt-4" disabled={loading} onClick={() => void detect()}>
            {loading ? '识别中…' : '开始识别'}
          </button>
        ) : (
          <ul className="mt-3 max-h-64 space-y-2 overflow-y-auto">
            {proposals.map((row, index) => (
              <li key={`${row.x}-${row.y}-${index}`} className="flex items-start gap-2 rounded-md border border-ink-700 p-2">
                <input
                  type="checkbox"
                  checked={picked.has(index)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(index)) next.delete(index);
                    else next.add(index);
                    setPicked(next);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-100">{row.source_text || '（无识别文本）'}</p>
                  <p className="text-[11px] text-ink-500">
                    ({row.x.toFixed(2)}, {row.y.toFixed(2)})
                  </p>
                </div>
                <select
                  className="input w-20 py-1 text-xs"
                  value={groups[index] ?? 1}
                  onChange={(e) => setGroups((prev) => ({ ...prev, [index]: Number(e.target.value) }))}
                >
                  <option value={1}>框内</option>
                  <option value={2}>框外</option>
                </select>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          {proposals.length > 0 && (
            <button type="button" className="btn-primary" disabled={loading} onClick={() => void accept()}>
              采纳所选
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
