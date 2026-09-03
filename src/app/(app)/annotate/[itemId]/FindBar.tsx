'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isPin, replaceInAnnotation, type DraftAnnotation } from '@/lib/annotation';

type SearchResult = {
  itemId: number;
  itemTitle: string | null;
  annotationId: number;
  kind: string;
  snippet: string;
};

type LocalMatch = { key: string; label: string; snippet: string; inSource: boolean };

/** 取命中位置附近的片段预览 */
function snippetOf(text: string, find: string): string {
  const index = text.indexOf(find);
  if (index < 0) return text.slice(0, 30).replace(/\n/g, '⏎');
  const start = Math.max(0, index - 12);
  const end = Math.min(text.length, index + find.length + 12);
  const body = text.slice(start, end).replace(/\n/g, '⏎');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * 查找 / 替换浮动条：
 * - 当前图：实时列出命中标注，点击选中并滚动到面板卡片；「全部替换」走 applyChange 保存链路（可撤销）
 * - 空间内：走 /annotations-search 搜索、/annotations-replace 批量替换，结果可跳转对应页
 * 匹配均为字面量精确匹配（不做正则，区分大小写）。
 */
export default function FindBar({
  annotations,
  spaceId,
  canEdit,
  onSelect,
  onChange,
  onClose,
}: {
  annotations: DraftAnnotation[];
  spaceId: number;
  canEdit: boolean;
  onSelect: (key: string) => void;
  onChange: (next: DraftAnnotation[]) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [includeSource, setIncludeSource] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keyword = find.trim();

  // 卡号映射：pin / box 在各自序列里的序号
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    let pinIndex = 0;
    let boxIndex = 0;
    for (const row of annotations) {
      if (isPin(row)) pinIndex += 1;
      else boxIndex += 1;
      map.set(row.key, isPin(row) ? `标号 ${pinIndex}` : `框 ${boxIndex}`);
    }
    return map;
  }, [annotations]);

  // 当前图实时命中
  const localMatches = useMemo<LocalMatch[]>(() => {
    if (!keyword) return [];
    const out: LocalMatch[] = [];
    for (const row of annotations) {
      const inText = row.text.includes(keyword);
      const inSource = includeSource && row.source_text.includes(keyword);
      if (!inText && !inSource) continue;
      out.push({
        key: row.key,
        label: labels.get(row.key) ?? '',
        snippet: snippetOf(inText ? row.text : row.source_text, keyword),
        inSource: !inText,
      });
    }
    return out;
  }, [annotations, keyword, includeSource, labels]);

  /** 点当前图命中项：选中并滚动到面板卡片 */
  function focusLocal(key: string) {
    onSelect(key);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-annotation-key="${key}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  /** 当前图全部替换：前端直接改（含 runs 富文本逐段替换），走 applyChange → 保存链路（可撤销） */
  function replaceAllLocal() {
    setError(null);
    setNotice(null);
    if (!keyword || !canEdit) return;
    let count = 0;
    const next = annotations.map((row) => {
      // 与服务端 annotations-replace 共用同一套替换逻辑（含 runs 同步）
      const result = replaceInAnnotation(row, keyword, replace, includeSource);
      if (!result.changed) return row;
      count += 1;
      return { ...row, text: result.text, source_text: result.source_text, runs: result.runs };
    });
    if (count > 0) onChange(next);
    setNotice(`已替换 ${count} 个标注（尚未保存时走自动保存 / Ctrl+S）`);
  }

  /** 空间内搜索 */
  async function searchSpace() {
    setError(null);
    setNotice(null);
    if (!keyword) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/spaces/${spaceId}/annotations-search?q=${encodeURIComponent(keyword)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '搜索失败');
        return;
      }
      setResults(data.results ?? []);
    } catch {
      setError('搜索失败');
    } finally {
      setBusy(false);
    }
  }

  /** 空间内全部替换（服务端批量改写） */
  async function replaceAllSpace() {
    setError(null);
    setNotice(null);
    if (!keyword || !canEdit) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/annotations-replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ find: keyword, replace, includeSource }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '替换失败');
        return;
      }
      setNotice(
        `空间内替换 ${data.changed} 个标注，涉及 ${data.titles.length} 张图：${data.titles
          .slice(0, 3)
          .join('、')}${data.titles.length > 3 ? ' 等' : ''}`,
      );
    } catch {
      setError('替换失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card absolute right-3 top-3 z-30 w-80 p-3">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          className="input h-8 flex-1 py-0 text-xs"
          placeholder="查找（字面量精确匹配）"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <button type="button" className="rounded px-1 text-ink-500 hover:text-ink-100" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          className="input h-8 flex-1 py-0 text-xs"
          placeholder="替换为"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          disabled={!canEdit}
        />
        <label className="flex items-center gap-1 text-[11px] text-ink-400" title="替换时连带原文">
          <input
            type="checkbox"
            checked={includeSource}
            onChange={(e) => setIncludeSource(e.target.checked)}
            disabled={!canEdit}
          />
          含原文
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-ink-500">
          当前图命中 {localMatches.length} 处{!keyword ? '（输入查找词）' : ''}
        </span>
        <button
          type="button"
          className="btn-ghost px-2 py-0.5"
          disabled={!canEdit || !keyword}
          onClick={replaceAllLocal}
        >
          全部替换
        </button>
        <button
          type="button"
          className="btn-ghost px-2 py-0.5"
          disabled={!keyword || busy}
          onClick={() => void searchSpace()}
        >
          空间内搜索
        </button>
        {canEdit && (
          <button
            type="button"
            className="btn-ghost px-2 py-0.5"
            disabled={!keyword || busy}
            onClick={() => void replaceAllSpace()}
            title="服务端批量改写空间内所有命中标注"
          >
            空间内替换
          </button>
        )}
      </div>

      {notice && <p className="notice-ok mt-2 text-[11px]">{notice}</p>}
      {error && <p className="notice-error mt-2 text-[11px]">{error}</p>}

      {/* 当前图命中列表 */}
      {localMatches.length > 0 && (
        <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
          {localMatches.map((match) => (
            <li key={match.key}>
              <button
                type="button"
                className="block w-full rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-paper"
                onClick={() => focusLocal(match.key)}
              >
                <span className="font-medium text-sky-deep">{match.label}</span>
                {match.inSource && <span className="ml-1 text-ink-500">（原文）</span>}
                <span className="ml-1">{match.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 空间内搜索结果：点击跳转到对应页并定位标注 */}
      {results !== null && (
        <div className="mt-2 border-t border-ink-700 pt-2">
          <p className="mb-1 text-[11px] text-ink-500">空间内命中 {results.length} 条（上限 200）</p>
          {results.length === 0 ? (
            <p className="text-[11px] text-ink-500">没有匹配的标注</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {results.map((row) => (
                <li key={`${row.itemId}-${row.annotationId}`}>
                  <button
                    type="button"
                    className="block w-full rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-paper"
                    onClick={() => router.push(`/annotate/${row.itemId}?focus=${row.annotationId}`)}
                  >
                    <span className="font-medium text-sky-deep">
                      {row.itemTitle || '未命名'}
                    </span>
                    <span className="ml-1 text-ink-500">
                      {row.kind === 'pin' ? '标号' : '框'} ·{' '}
                    </span>
                    <span>{row.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
