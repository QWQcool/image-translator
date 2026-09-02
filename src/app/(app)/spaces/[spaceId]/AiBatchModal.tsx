'use client';

import { useState } from 'react';

type BatchItem = { id: number; title: string | null };

type ItemResult = {
  id: number;
  title: string;
  status: 'pending' | 'running' | 'ok' | 'fail';
  message: string;
};

/**
 * 6d AI 批量处理：勾选多张图（或全部），逐张串行执行 检测+提取(+翻译)。
 * 复用单条目接口：OCR → 采纳 →（可选）AI 翻译 → 写入译文。
 * 每张之间串行，失败继续下一张，最后汇总结果。
 */
export default function AiBatchModal({
  items,
  onClose,
  onDone,
}: {
  items: BatchItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(items.map((i) => i.id)));
  const [withTranslate, setWithTranslate] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ItemResult[]>(
    items.map((i) => ({ id: i.id, title: i.title || '未命名', status: 'pending', message: '' })),
  );

  function setResult(id: number, patch: Partial<ItemResult>) {
    setResults((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function toggle(id: number) {
    if (running) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function processOne(itemId: number): Promise<void> {
    setResult(itemId, { status: 'running', message: 'AI 识别中…' });

    // 1) 检测：AI OCR 出文字块建议
    const ocrRes = await fetch(`/api/items/${itemId}/ocr`, { method: 'POST' });
    const ocrData = await ocrRes.json();
    if (!ocrRes.ok) {
      throw new Error(ocrData.error ?? '识别失败');
    }
    const proposals = (ocrData.proposals ?? []) as Array<{
      x: number;
      y: number;
      source_text: string;
    }>;
    if (proposals.length === 0) {
      setResult(itemId, { status: 'ok', message: '没有检出文字，跳过' });
      return;
    }

    // 2) 提取：全部采纳为标号（默认组 1）
    const acceptRes = await fetch(`/api/items/${itemId}/ocr/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposals: proposals.map((p) => ({
          x: p.x,
          y: p.y,
          source_text: p.source_text,
          group_id: 1,
        })),
      }),
    });
    if (!acceptRes.ok) {
      const data = await acceptRes.json().catch(() => ({ error: '采纳失败' }));
      throw new Error(data.error ?? '采纳失败');
    }

    if (!withTranslate) {
      setResult(itemId, { status: 'ok', message: `识别并提取 ${proposals.length} 条原文` });
      return;
    }

    // 3) 翻译：原文列表发对话模型，译文直接写入标号
    setResult(itemId, { status: 'running', message: 'AI 翻译中…' });
    const trRes = await fetch(`/api/items/${itemId}/ai-translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const trData = await trRes.json();
    if (!trRes.ok) {
      throw new Error(`已提取 ${proposals.length} 条原文；翻译失败：${trData.error ?? '未知错误'}`);
    }
    const trProposals = (trData.proposals ?? []) as Array<{ id: number; translated: string }>;
    const acceptTrRes = await fetch(`/api/items/${itemId}/ai-translate/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        translations: trProposals
          .filter((p) => p.translated.trim())
          .map((p) => ({ id: p.id, text: p.translated })),
      }),
    });
    if (!acceptTrRes.ok) {
      throw new Error(`已提取原文；写入译文失败`);
    }
    setResult(itemId, {
      status: 'ok',
      message: `识别 ${proposals.length} 条 · 翻译写入 ${(trProposals ?? []).filter((p) => p.translated.trim()).length} 条`,
    });
  }

  async function run() {
    if (selected.size === 0) return;
    setRunning(true);
    // 串行执行：一张处理完（无论成败）再处理下一张
    for (const item of items) {
      if (!selected.has(item.id)) continue;
      try {
        await processOne(item.id);
      } catch (err) {
        // 失败继续下一张
        setResult(item.id, {
          status: 'fail',
          message: err instanceof Error ? err.message : '处理失败',
        });
      }
    }
    setRunning(false);
    onDone();
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const done = !running && (okCount + failCount > 0);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-100/30 p-4">
      <div className="card w-full max-w-lg p-4">
        <h2 className="font-display text-lg text-ink-100">AI 批量处理</h2>
        <p className="mt-1 text-xs text-ink-400">
          对勾选的图片逐张串行执行：AI 识别 → 提取为标号（组 1）
          {withTranslate ? ' → AI 翻译并写入译文' : ''}。失败自动跳过下一张。
        </p>

        {!running && !done && (
          <label className="mt-2 flex items-center gap-2 text-xs text-ink-400">
            <input type="checkbox" checked={withTranslate} onChange={(e) => setWithTranslate(e.target.checked)} />
            识别后继续 AI 翻译（译文直接写入标号，无人值守模式）
          </label>
        )}

        <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
          {results.map((row) => (
            <li key={row.id} className="flex items-center gap-2 rounded-md border border-ink-700 px-2 py-1.5">
              <input
                type="checkbox"
                disabled={running}
                checked={selected.has(row.id)}
                onChange={() => toggle(row.id)}
              />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-200">{row.title}</span>
              <span className="shrink-0 text-[11px]">
                {row.status === 'pending' && <span className="text-ink-500">等待</span>}
                {row.status === 'running' && <span className="text-sky-deep">处理中…</span>}
                {row.status === 'ok' && <span className="text-emerald-700">✓ {row.message}</span>}
                {row.status === 'fail' && <span className="text-blush">✗ {row.message}</span>}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-xs text-ink-500">
            已选 {selected.size} / {items.length}
            {done && ` · 成功 ${okCount} · 失败 ${failCount}`}
          </span>
          <span className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {done ? '关闭' : '取消'}
            </button>
            {!done && (
              <button
                type="button"
                className="btn-primary"
                disabled={running || selected.size === 0}
                onClick={() => void run()}
              >
                {running ? '处理中…' : '开始处理'}
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
