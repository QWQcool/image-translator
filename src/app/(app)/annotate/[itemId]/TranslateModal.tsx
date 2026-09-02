'use client';

import { useEffect, useRef, useState } from 'react';
import type { DraftAnnotation } from '@/lib/annotation';

type TranslateProposal = {
  id: number;
  source_text: string;
  translated: string;
};

type ProviderOption = { id: number; name: string; isDefault: boolean };

/**
 * 6b AI 翻译弹层：调 /ai-translate 拿译文 proposals（服务端不写库），
 * 逐条预览、可改、勾选后把译文交给编辑器写进对应标号的 text（走编辑器保存路径）。
 */
export default function TranslateModal({
  itemId,
  onClose,
  onApply,
}: {
  itemId: number;
  onClose: () => void;
  /** 传回勾选的译文（id = 标注行 id），由编辑器负责写入、保存与广播 */
  onApply: (updates: Array<{ id: number; text: string }>) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<TranslateProposal[]>([]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [context, setContext] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const providerIdRef = useRef(0);

  async function translate(targetProviderId: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/ai-translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: targetProviderId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'AI 翻译失败');
        return;
      }
      const list = (data.proposals ?? []) as TranslateProposal[];
      setProposals(list);
      setPicked(new Set(list.filter((p) => p.translated.trim()).map((p) => p.id)));
      setContext(data.context ?? null);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }

  // 打开即用默认 Provider 翻译
  useEffect(() => {
    void translate(0);
    // 顺带拉 Provider 列表：多于一条时给个切换下拉
    void (async () => {
      try {
        const res = await fetch('/api/ai/providers');
        const data = await res.json();
        setProviders(((data.providers ?? []) as ProviderOption[]).map((p) => p));
      } catch {
        // 列表拉不到不影响翻译
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const apply = () => {
    const selected = proposals.filter((p) => picked.has(p.id));
    if (selected.length === 0) {
      setError('请至少勾选一条译文');
      return;
    }
    onApply(selected.map((p) => ({ id: p.id, text: p.translated })));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink-100/30 p-4">
      <div className="card w-full max-w-xl p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg text-ink-100">AI 翻译</h2>
          {providers.length > 1 && (
            <select
              className="input w-44 py-1 text-xs"
              defaultValue=""
              onChange={(e) => {
                const id = Number(e.target.value);
                providerIdRef.current = id;
                void translate(id);
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-400">
          译文只是建议：逐条检查、可直接修改，勾选后写入对应标号。
          {context && (
            <span className="mt-1 block rounded bg-paper px-2 py-1 text-[11px] text-ink-500">
              画面提示：{context}
            </span>
          )}
        </p>
        {error && <p className="notice-error mt-2">{error}</p>}

        {loading ? (
          <p className="py-8 text-center text-sm text-ink-500">AI 翻译中…</p>
        ) : proposals.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-500">没有可翻译的原文</p>
        ) : (
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
            {proposals.map((row) => (
              <li key={row.id} className="flex items-start gap-2 rounded-md border border-ink-700 p-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.has(row.id)}
                  onChange={() => {
                    const next = new Set(picked);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    setPicked(next);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-ink-500" title={row.source_text}>
                    原文：{row.source_text}
                  </p>
                  <input
                    className="input mt-1 py-1 text-sm"
                    value={row.translated}
                    onChange={(e) =>
                      setProposals((prev) =>
                        prev.map((p) => (p.id === row.id ? { ...p, translated: e.target.value } : p)),
                      )
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            取消
          </button>
          {!loading && proposals.length > 0 && (
            <button type="button" className="btn-primary" onClick={apply}>
              写入所选（{picked.size}）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
