'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import { originalUrl, previewUrl } from '@/lib/media';
import { newKey, type DraftAnnotation } from '@/lib/annotation';
import type { Asset, SpaceAccess, SpaceItem } from '@/lib/types';
import AnnotationCanvas from './AnnotationCanvas';
import AnnotationPanel from './AnnotationPanel';

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
      setAnnotations(
        (annotationData.annotations ?? []).map((row: DraftAnnotation) => ({
          ...row,
          key: newKey(),
        })),
      );
      setDirty(false);
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

  const save = useCallback(async () => {
    if (!item || !access?.canEdit) return;
    setSaving(true);
    setError(null);
    try {
      const payload = annotations.map(({ key, ...rest }) => rest);
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
      // 用服务端返回的记录回填，保证后续编辑带上真实 id
      setAnnotations((prev) =>
        (data.annotations ?? []).map((row: DraftAnnotation, index: number) => ({
          ...row,
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
  }, [annotations, item, itemId]);

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

  // Ctrl/Cmd+S 保存；非输入状态下 Delete 删除选中标注
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target ? ['INPUT', 'TEXTAREA'].includes(target.tagName) : false;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (canEdit) void save();
        return;
      }
      if (typing || !canEdit) return;

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedKey) {
        event.preventDefault();
        applyChange(annotations.filter((annotation) => annotation.key !== selectedKey));
        setSelectedKey(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [annotations, selectedKey, save, applyChange, canEdit]);

  // 离开页面前提醒未保存的改动
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

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-4">
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

      {error && (
        <p className="notice-error">{error}</p>
      )}

      <div className="flex min-h-0 flex-1 gap-5">
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
        />

        <aside className="flex w-[350px] shrink-0 flex-col rounded-xl border border-ink-700 bg-cloud/80 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-ink-100">
              标注 <span className="text-ink-500">({annotations.length})</span>
            </h2>
            <span className="text-[11px] text-ink-400">
              {canEdit ? 'Ctrl+S 保存 · Delete 删除' : '只读模式'}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <AnnotationPanel
              annotations={annotations}
              selectedKey={selectedKey}
              imageHeight={imageHeight}
              onSelect={setSelectedKey}
              onChange={applyChange}
              readOnly={!canEdit}
              onRemove={(key) => {
                if (!canEdit) return;
                applyChange(annotations.filter((annotation) => annotation.key !== key));
                if (selectedKey === key) setSelectedKey(null);
              }}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
