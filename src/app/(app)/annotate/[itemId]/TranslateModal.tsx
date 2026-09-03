'use client';

import { useEffect, useRef, useState } from 'react';
import { parseGlossary, type GlossaryEntry } from '@/lib/labelplus';

type TranslateProposal = {
  id: number;
  source_text: string;
  translated: string;
};

type ProviderOption = { id: number; name: string; isDefault: boolean };

/**
 * 6b AI 翻译弹层：调 /ai-translate 拿译文 proposals（服务端不写库），
 * 逐条预览、可改、勾选后把译文交给编辑器写进对应标号的 text（走编辑器保存路径）。
 * 附带空间级术语表编辑（保存走 PATCH spaces）；命中判定与注入在服务端做。
 */
export default function TranslateModal({
  itemId,
  spaceId,
  canEdit,
  onClose,
  onApply,
}: {
  itemId: number;
  /** 当前条目所属空间（术语表挂在空间上） */
  spaceId: number;
  /** 只读用户可看术语表但不能编辑 */
  canEdit: boolean;
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

  // ---- 术语表 ----
  const [glossOpen, setGlossOpen] = useState(false);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [fullGlossary, setFullGlossary] = useState(false);
  const [glossHits, setGlossHits] = useState<number | null>(null);
  const [glossSaving, setGlossSaving] = useState(false);
  const [glossNote, setGlossNote] = useState<string | null>(null);
  const fullGlossaryRef = useRef(false);
  fullGlossaryRef.current = fullGlossary;

  // 打开时拉取空间术语表
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/spaces/${spaceId}`);
        const data = await res.json();
        setGlossary(parseGlossary(data.space?.lp_glossary));
      } catch {
        // 拉不到术语表不影响翻译
      }
    })();
  }, [spaceId]);

  async function translate(targetProviderId: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/ai-translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: targetProviderId || undefined,
          fullGlossary: fullGlossaryRef.current || undefined,
        }),
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
      setGlossHits(typeof data.glossaryHits === 'number' ? data.glossaryHits : null);
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

  /** 保存术语表到空间（PATCH spaces，全员共用） */
  async function saveGlossary() {
    setGlossSaving(true);
    setGlossNote(null);
    try {
      const res = await fetch(`/api/spaces/${spaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lp_glossary: glossary }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGlossNote(data.error ?? '术语表保存失败');
        return;
      }
      setGlossary(parseGlossary(data.space?.lp_glossary));
      setGlossNote('术语表已保存');
    } catch {
      setGlossNote('术语表保存失败');
    } finally {
      setGlossSaving(false);
    }
  }

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
      <div className="card flex max-h-[85vh] w-full max-w-xl flex-col p-4">
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

        {/* 术语表折叠区：编辑与勾选在这里，命中判定/注入在服务端 */}
        <div className="mt-2 rounded-lg border border-ink-700">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink-200"
            onClick={() => setGlossOpen((v) => !v)}
          >
            <span className="font-medium">术语表（{glossary.length} 条）</span>
            {glossHits !== null && (
              <span className="rounded bg-sky/15 px-1.5 py-0.5 text-[10px] text-sky-deep">
                命中 {glossHits} 条
              </span>
            )}
            <span className="ml-auto text-ink-500">{glossOpen ? '收起 ▴' : '展开 ▾'}</span>
          </button>
          {glossOpen && (
            <div className="border-t border-ink-700 p-2.5">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-500">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={fullGlossary}
                    onChange={(e) => setFullGlossary(e.target.checked)}
                  />
                  附加整个术语表
                </label>
                <span>（默认只注入原文命中的术语）</span>
                {canEdit && (
                  <button
                    type="button"
                    className="btn-ghost ml-auto px-2 py-0.5 text-[11px]"
                    onClick={() => setGlossary((prev) => [...prev, { from: '', to: '' }])}
                  >
                    添加
                  </button>
                )}
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {glossary.length === 0 && (
                  <p className="py-1 text-[11px] text-ink-500">还没有术语。添加「原文词 → 译文词」后，AI 翻译会优先采用。</p>
                )}
                {glossary.map((entry, index) => (
                  <div key={index} className="flex items-center gap-1">
                    <input
                      className="input h-7 w-24 px-1.5 py-0 text-xs"
                      placeholder="原文词"
                      value={entry.from}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setGlossary((prev) =>
                          prev.map((row, i) => (i === index ? { ...row, from: e.target.value } : row)),
                        )
                      }
                    />
                    <span className="text-ink-600">→</span>
                    <input
                      className="input h-7 w-24 px-1.5 py-0 text-xs"
                      placeholder="译文词"
                      value={entry.to}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setGlossary((prev) =>
                          prev.map((row, i) => (i === index ? { ...row, to: e.target.value } : row)),
                        )
                      }
                    />
                    <input
                      className="input h-7 min-w-0 flex-1 px-1.5 py-0 text-xs"
                      placeholder="备注（可选）"
                      value={entry.note ?? ''}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setGlossary((prev) =>
                          prev.map((row, i) => (i === index ? { ...row, note: e.target.value } : row)),
                        )
                      }
                    />
                    {canEdit && (
                      <button
                        type="button"
                        className="rounded px-1 text-blush hover:bg-blush/15"
                        title="删除该术语"
                        onClick={() => setGlossary((prev) => prev.filter((_, i) => i !== index))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {canEdit && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary px-2 py-1 text-[11px]"
                    disabled={glossSaving}
                    onClick={() => void saveGlossary()}
                  >
                    {glossSaving ? '保存中…' : '保存到空间'}
                  </button>
                  <span className="text-[10px] text-ink-500">全员共用，上限 200 条</span>
                  {glossNote && <span className="text-[11px] text-sky-deep">{glossNote}</span>}
                </div>
              )}
            </div>
          )}
        </div>

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
