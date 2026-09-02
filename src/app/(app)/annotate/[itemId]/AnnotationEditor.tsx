'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import { originalUrl, previewUrl, thumbUrl } from '@/lib/media';
import { isPin, newKey, type DraftAnnotation } from '@/lib/annotation';
import { parseGroups, parsePhrases } from '@/lib/labelplus';
import type { Asset, LabelPlusGroup, SpaceAccess, SpaceItem } from '@/lib/types';
import AnnotationCanvas, { type EditorMode } from './AnnotationCanvas';
import AnnotationPanel from './AnnotationPanel';
import LabelPlusPanel from './LabelPlusPanel';

const MODES: Array<{ id: EditorMode; key: string; label: string }> = [
  { id: 'box', key: '', label: '框选' },
  { id: 'browse', key: 'Q', label: '浏览' },
  { id: 'label', key: 'W', label: '标号' },
  { id: 'input', key: 'E', label: '录入' },
  { id: 'review', key: 'R', label: '审校' },
];

type NeighborItem = {
  id: number;
  title: string | null;
  thumb_filename: string | null;
  filename: string;
  original_name: string | null;
};

function hydrate(row: DraftAnnotation): DraftAnnotation {
  return {
    ...row,
    key: newKey(),
    kind: row.kind === 'pin' || (row.w === 0 && row.h === 0 && row.kind !== 'box') ? 'pin' : 'box',
    group_id: row.group_id || 1,
    source_text: row.source_text ?? '',
    comment: row.comment ?? '',
  };
}

export default function AnnotationEditor({ itemId }: { itemId: number }) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<SpaceItem | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [spaceName, setSpaceName] = useState('');
  const [annotations, setAnnotations] = useState<DraftAnnotation[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [mode, setMode] = useState<EditorMode>('box');
  const [hidePins, setHidePins] = useState(false);
  const [showGroupNames, setShowGroupNames] = useState(false);
  const [defaultGroupId, setDefaultGroupId] = useState(1);
  const [groups, setGroups] = useState<LabelPlusGroup[]>([]);
  const [phrases, setPhrases] = useState<string[]>([]);
  const [neighbors, setNeighbors] = useState<{
    prevId: number | null;
    nextId: number | null;
    items: NeighborItem[];
  }>({ prevId: null, nextId: null, items: [] });

  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const canEditRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, annotationRes] = await Promise.all([
        fetch(`/api/items/${itemId}`),
        fetch(`/api/items/${itemId}/annotations`),
      ]);
      if (detailRes.status === 404) {
        router.replace('/spaces');
        return;
      }
      const detail = await detailRes.json();
      const annotationData = await annotationRes.json();

      setItem(detail.item ?? null);
      setAsset(detail.asset ?? null);
      setSpaceName(detail.space?.name ?? '');
      setTitle(detail.item?.title ?? '');
      setAccess(detail.access ?? null);
      setAnnotations((annotationData.annotations ?? []).map((row: DraftAnnotation) => hydrate(row)));
      setDirty(false);
      setSelectedKey(null);
      setGroups(parseGroups(detail.labelplus?.groups));
      setPhrases(parsePhrases(detail.labelplus?.phrases));
      setNeighbors({
        prevId: detail.neighbors?.prevId ?? null,
        nextId: detail.neighbors?.nextId ?? null,
        items: detail.neighbors?.items ?? [],
      });
    } catch {
      setError('加载失败，请刷新重试');
    } finally {
      setLoading(false);
    }
  }, [itemId, router]);

  useEffect(() => {
    if (!Number.isInteger(itemId) || itemId <= 0) {
      router.replace('/spaces');
      return;
    }
    void load();
  }, [itemId, load, router]);

  const applyChange = useCallback((next: DraftAnnotation[]) => {
    setAnnotations(next);
    setDirty(true);
  }, []);

  const canEdit = access?.canEdit ?? false;
  canEditRef.current = canEdit;

  const save = useCallback(async () => {
    if (!item || !canEditRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const payload = annotationsRef.current.map(({ key: _key, ...rest }) => rest);
      const res = await fetch(`/api/items/${itemId}/annotations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: payload }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存失败');
        return;
      }
      setAnnotations((prev) =>
        (data.annotations ?? []).map((row: DraftAnnotation, index: number) => ({
          ...hydrate(row),
          key: prev[index]?.key ?? newKey(),
        })),
      );
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString('zh-CN'));
    } catch {
      setError('保存过程中发生网络错误');
    } finally {
      setSaving(false);
    }
  }, [item, itemId]);

  useEffect(() => {
    if (!dirty || !canEdit || mode === 'box') return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, annotations, canEdit, mode, save]);

  async function saveTitle() {
    setEditingTitle(false);
    const next = title.trim();
    if (!next || next === item?.title) return;
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: next }),
    });
    if (!res.ok) setError('重命名失败');
  }

  const goItem = useCallback(
    async (targetId: number | null) => {
      if (!targetId) return;
      if (dirtyRef.current && canEditRef.current) await save();
      router.push(`/annotate/${targetId}`);
    },
    [router, save],
  );

  const pins = useMemo(() => annotations.filter(isPin), [annotations]);

  const selectPinByOffset = useCallback(
    (delta: number) => {
      if (pins.length === 0) return;
      const index = pins.findIndex((p) => p.key === selectedKey);
      const next = pins[(index < 0 ? 0 : index + delta + pins.length) % pins.length];
      setSelectedKey(next.key);
    },
    [pins, selectedKey],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target ? ['INPUT', 'TEXTAREA'].includes(target.tagName) : false;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (canEdit) void save();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        selectPinByOffset(1);
        return;
      }

      if (typing) return;

      if (event.key === 'q' || event.key === 'Q') setMode('browse');
      if (event.key === 'w' || event.key === 'W') setMode('label');
      if (event.key === 'e' || event.key === 'E') setMode('input');
      if (event.key === 'r' || event.key === 'R') setMode('review');
      if (event.key === 'v' || event.key === 'V') setHidePins((v) => !v);
      if (event.key === 'c' || event.key === 'C') setShowGroupNames((v) => !v);
      if (/^[1-9]$/.test(event.key)) {
        const id = Number(event.key);
        setDefaultGroupId(id);
        if (selectedKey && canEdit) {
          applyChange(
            annotationsRef.current.map((row) =>
              row.key === selectedKey && isPin(row) ? { ...row, group_id: id } : row,
            ),
          );
        }
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void goItem(neighbors.prevId);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void goItem(neighbors.nextId);
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectPinByOffset(-1);
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectPinByOffset(1);
      }

      if (!canEdit) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedKey) {
        event.preventDefault();
        applyChange(annotations.filter((annotation) => annotation.key !== selectedKey));
        setSelectedKey(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [annotations, selectedKey, save, applyChange, canEdit, neighbors, goItem, selectPinByOffset]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (loading) {
    return <p className="py-20 text-center text-sm text-ink-500">加载中…</p>;
  }
  if (!item || !asset) {
    return (
      <div className="card py-20 text-center">
        <EmptyState padded={false} kaomoji="(・・?)" title={error ?? '图片不存在或已被移除'} />
        <Link href="/spaces" className="btn-ghost mt-2">
          返回空间列表
        </Link>
      </div>
    );
  }

  const imageWidth = asset.width ?? 1200;
  const imageHeight = asset.height ?? 800;
  const pinMode = mode !== 'box';

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/spaces/${item.space_id}`} className="text-sm text-ink-400 hover:text-sky-deep">
          ← {spaceName || '返回空间'}
        </Link>
        <span className="text-ink-700">/</span>
        {editingTitle ? (
          <input
            autoFocus
            className="input max-w-xs py-1"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveTitle();
              if (event.key === 'Escape') {
                setTitle(item.title ?? '');
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => canEdit && setEditingTitle(true)}
            className={`text-sm font-medium ${
              canEdit ? 'text-ink-100 hover:text-sky-deep' : 'cursor-default text-ink-400'
            }`}
            title={canEdit ? '点击重命名' : undefined}
          >
            {item.title || '未命名'}
          </button>
        )}

        <div className="seg ml-2 flex flex-wrap gap-1">
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`seg-btn ${mode === entry.id ? 'seg-btn-on' : ''}`}
              onClick={() => setMode(entry.id)}
              title={entry.key ? `${entry.label}（${entry.key}）` : entry.label}
            >
              {entry.label}
              {entry.key && <span className="ml-1 text-[10px] opacity-60">{entry.key}</span>}
            </button>
          ))}
          <button type="button" className="seg-btn" onClick={() => router.push(`/typeset/${itemId}`)}>
            嵌字
          </button>
        </div>

        <span className="ml-auto flex items-center gap-3">
          {canEdit ? (
            <>
              <span className="text-xs text-ink-500">
                {dirty ? '有未保存的更改' : savedAt ? `已保存 ${savedAt}` : ''}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </>
          ) : (
            <span className="rounded bg-ink-800 px-2 py-1 text-xs text-ink-400">只读</span>
          )}
        </span>
      </div>

      {error && <p className="notice-error">{error}</p>}

      <div className="flex min-h-0 flex-1 gap-5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AnnotationCanvas
            imageSrc={originalUrl(asset.filename)}
            previewSrc={previewUrl(asset.filename)}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            annotations={annotations}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            onChange={applyChange}
            fileName={asset.original_name ?? asset.filename}
            readOnly={!canEdit}
            mode={mode}
            hidePins={hidePins}
            showGroupNames={showGroupNames || mode === 'review'}
            defaultGroupId={defaultGroupId}
            followSelection={mode === 'input'}
          />
          {neighbors.items.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {neighbors.items.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => void goItem(entry.id)}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-md border ${
                    entry.id === itemId ? 'border-sky ring-1 ring-sky' : 'border-ink-700'
                  }`}
                  title={entry.title ?? entry.original_name ?? ''}
                >
                  <img
                    src={thumbUrl(entry.thumb_filename, entry.filename)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="flex w-[350px] shrink-0 flex-col rounded-xl border border-ink-700 bg-cloud/80 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-100">
              {pinMode ? '标号' : '标注'}{' '}
              <span className="text-ink-500">({pinMode ? pins.length : annotations.filter((a) => !isPin(a)).length})</span>
            </h2>
            <span className="text-[11px] text-ink-400">
              {canEdit ? 'Ctrl+S · ←→ 翻图 · ↑↓ 切号' : '只读模式'}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {pinMode ? (
              <LabelPlusPanel
                annotations={annotations}
                selectedKey={selectedKey}
                groups={groups}
                phrases={phrases}
                defaultGroupId={defaultGroupId}
                reviewMode={mode === 'review'}
                onSelect={setSelectedKey}
                onChange={applyChange}
                readOnly={!canEdit}
                onDefaultGroup={setDefaultGroupId}
                onInsertPhrase={(phrase) => {
                  if (!selectedKey || !canEdit) return;
                  applyChange(
                    annotations.map((row) =>
                      row.key === selectedKey ? { ...row, text: `${row.text}${phrase}` } : row,
                    ),
                  );
                }}
                onRemove={(key) => {
                  if (!canEdit) return;
                  applyChange(annotations.filter((annotation) => annotation.key !== key));
                  if (selectedKey === key) setSelectedKey(null);
                }}
              />
            ) : (
              <AnnotationPanel
                annotations={annotations.filter((a) => !isPin(a))}
                selectedKey={selectedKey}
                imageHeight={imageHeight}
                onSelect={setSelectedKey}
                onChange={(nextBoxes) => {
                  applyChange([...nextBoxes, ...annotations.filter(isPin)]);
                }}
                readOnly={!canEdit}
                onRemove={(key) => {
                  if (!canEdit) return;
                  applyChange(annotations.filter((annotation) => annotation.key !== key));
                  if (selectedKey === key) setSelectedKey(null);
                }}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
