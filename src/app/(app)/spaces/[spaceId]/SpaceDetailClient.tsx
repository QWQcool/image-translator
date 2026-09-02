'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { thumbUrl } from '@/lib/media';
import type { Space, SpaceAccess, SpaceItem, SpaceVisibility } from '@/lib/types';
import AddImagesModal from './AddImagesModal';
import ExportMenu from './ExportMenu';
import MembersPanel, { ROLE_LABEL } from './MembersPanel';

export default function SpaceDetailClient({ spaceId }: { spaceId: number }) {
  const router = useRouter();
  const [space, setSpace] = useState<Space | null>(null);
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [items, setItems] = useState<SpaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [renamingSpace, setRenamingSpace] = useState(false);
  const [spaceDraft, setSpaceDraft] = useState({
    name: '',
    description: '',
    visibility: 'private' as SpaceVisibility,
  });
  const [pendingDeleteItem, setPendingDeleteItem] = useState<SpaceItem | null>(null);
  const [pendingDeleteSpace, setPendingDeleteSpace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}`);
      if (res.status === 404 || res.status === 403) {
        router.replace('/spaces');
        return;
      }
      const data = await res.json();
      setSpace(data.space ?? null);
      setAccess(data.access ?? null);
      setItems(Array.isArray(data.items) ? data.items : []);
    } finally {
      setLoading(false);
    }
  }, [spaceId, router]);

  useEffect(() => {
    if (!Number.isInteger(spaceId) || spaceId <= 0) {
      router.replace('/spaces');
      return;
    }
    void load();
  }, [spaceId, load, router]);

  async function saveSpace() {
    if (!space) return;
    const name = spaceDraft.name.trim();
    if (!name) {
      setError('空间名称不能为空');
      return;
    }
    const res = await fetch(`/api/spaces/${spaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: spaceDraft.description.trim() || null,
        visibility: spaceDraft.visibility,
      }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? '保存失败');
      return;
    }
    setRenamingSpace(false);
    setError(null);
    await load();
  }

  async function saveItemTitle(itemId: number) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;
    const before = items.find((i) => i.id === itemId)?.title ?? '';
    if (title === before) return;
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, title } : i)));
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      setError('重命名失败');
      await load();
    }
  }

  async function removeItem() {
    const item = pendingDeleteItem;
    setPendingDeleteItem(null);
    if (!item) return;
    const res = await fetch(`/api/items/${item.id}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('移除失败');
      return;
    }
    await load();
  }

  async function deleteSpace() {
    setPendingDeleteSpace(false);
    const res = await fetch(`/api/spaces/${spaceId}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('删除空间失败');
      return;
    }
    router.replace('/spaces');
    router.refresh();
  }

  if (loading && !space) {
    return <p className="py-20 text-center text-sm text-ink-500">加载中…</p>;
  }
  if (!space || !access) return null;

  const canEdit = access.canEdit;
  const canManage = access.canManage;
  const totalAnnotations = items.reduce((sum, item) => sum + (item.annotation_count ?? 0), 0);

  return (
    <div className="space-y-6">
      <Link href="/spaces" className="inline-block text-sm text-ink-400 hover:text-sky-deep">
        ← 返回空间列表
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        {renamingSpace ? (
          <div className="w-full max-w-xl space-y-3">
            <div>
              <label className="label">空间名称</label>
              <input
                className="input"
                value={spaceDraft.name}
                autoFocus
                onChange={(e) => setSpaceDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="label">描述</label>
              <textarea
                className="input min-h-[70px] resize-y"
                value={spaceDraft.description}
                onChange={(e) => setSpaceDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>
            <div>
              <span className="label">可见性</span>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { value: 'private', title: '仅成员可见', hint: '只有通过邀请加入的人能访问' },
                    { value: 'public', title: '公开', hint: '所有登录用户可见，非成员只能查看' },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSpaceDraft((d) => ({ ...d, visibility: option.value }))}
                    className={`rounded-lg border p-2.5 text-left transition-colors ${
                      spaceDraft.visibility === option.value
                      ? 'border-sky bg-sky/10'
                      : 'border-ink-700 hover:border-sky/30'
                    }`}
                  >
                    <div className="text-sm font-medium text-ink-100">{option.title}</div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
                      {option.hint}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-primary" onClick={() => void saveSpace()}>
                保存
              </button>
              <button type="button" className="btn-ghost" onClick={() => setRenamingSpace(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display truncate text-2xl tracking-wide text-ink-100">{space.name}</h1>
              <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-400">
                {ROLE_LABEL[access.role]}
              </span>
              {canManage && (
                <button
                  type="button"
                  className="btn-ghost px-2 py-1 text-xs"
                  onClick={() => {
                    setSpaceDraft({
                      name: space.name,
                      description: space.description ?? '',
                      visibility: space.visibility,
                    });
                    setRenamingSpace(true);
                  }}
                >
                  编辑
                </button>
              )}
            </div>
            <p className="mt-1 text-sm text-ink-400">{space.description || '还没写简介'}</p>
            <p className="mt-1.5 text-xs text-ink-400">
              {items.length} 张图片 · {totalAnnotations} 条标注 ·{' '}
              {space.visibility === 'public' ? '🌐 公开（非成员只读）' : '🔒 仅成员可见'}
            </p>
          </div>
        )}

        {!renamingSpace && (
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}>
                添加图片
              </button>
            )}
            <MembersPanel spaceId={spaceId} canManage={canManage} onChanged={() => void load()} />
            <ExportMenu spaceId={spaceId} disabled={items.length === 0} />
            {canManage && (
              <button
                type="button"
                className="btn-danger"
                onClick={() => setPendingDeleteSpace(true)}
              >
                删除空间
              </button>
            )}
          </div>
        )}
      </div>

      {!canEdit && (
        <p className="rounded-lg border border-sky/20 bg-sky/5 px-3 py-2 text-xs text-ink-400">
          你在该空间是<strong className="text-ink-100">只读</strong>权限，可以查看和导出标注，
          但不能添加、修改或删除内容。
        </p>
      )}

      {error && (
        <p className="notice-error">{error}</p>
      )}

      {items.length === 0 ? (
        <EmptyState
          showMascot
          kaomoji="(๑•̀ㅂ•́)و✧"
          title="这个空间还没有图片"
          hint={canEdit ? '点击「添加图片」从图库中挑选' : '等待有编辑权限的成员添加'}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {items.map((item) => (
            <div key={item.id} className="card group overflow-hidden">
              <Link
                href={`/annotate/${item.id}`}
                className="block"
                onClick={(event) => {
                  if (!canEdit) event.preventDefault();
                }}
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-paper">
                  <img
                    src={thumbUrl(item.asset?.thumb_filename ?? null, item.asset?.filename ?? '')}
                    alt={item.title ?? ''}
                    loading="lazy"
                    className={`h-full w-full object-cover transition-transform ${
                      canEdit ? 'group-hover:scale-[1.03]' : ''
                    }`}
                  />
                  {(item.annotation_count ?? 0) > 0 && (
                    <span className="absolute right-2 top-2 rounded-md bg-sky/90 px-1.5 py-0.5 text-[11px] font-medium text-white">
                      {item.annotation_count} 标注
                    </span>
                  )}
                </div>
              </Link>

              <div className="p-3">
                {editingId === item.id && canEdit ? (
                  <input
                    autoFocus
                    className="input px-2 py-1 text-xs"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => void saveItemTitle(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveItemTitle(item.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={!canEdit}
                    onClick={() => {
                      setEditingId(item.id);
                      setEditingTitle(item.title ?? '');
                    }}
                    className={`block w-full truncate text-left text-xs ${
                      canEdit ? 'text-ink-200 hover:text-sky-deep' : 'cursor-default text-ink-400'
                    }`}
                    title={canEdit ? '点击重命名' : undefined}
                  >
                    {item.title || '未命名'}
                  </button>
                )}

                <p className="mt-1 truncate text-[11px] text-ink-400">
                  {item.asset?.width && item.asset?.height
                    ? `${item.asset.width}×${item.asset.height}`
                    : ''}
                </p>

                <div className="mt-2.5 flex gap-2">
                  <Link
                    href={`/annotate/${item.id}`}
                    className="btn-primary flex-1 py-1 text-xs"
                  >
                    {canEdit ? '标注' : '查看'}
                  </Link>
                  <Link href={`/typeset/${item.id}`} className="btn-ghost flex-1 py-1 text-xs">
                    嵌字
                  </Link>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn-danger flex-1 py-1 text-xs"
                      onClick={() => setPendingDeleteItem(item)}
                    >
                      移除
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <AddImagesModal
          open={addOpen}
          spaceId={spaceId}
          existingAssetIds={items.map((i) => i.asset_id)}
          onClose={() => setAddOpen(false)}
          onAdded={() => void load()}
        />
      )}

      <Modal
        open={pendingDeleteItem !== null}
        title="从空间移除图片"
        onClose={() => setPendingDeleteItem(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDeleteItem(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void removeItem()}>
              确认移除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将把「{pendingDeleteItem?.title || '未命名'}」从本空间移除，其
          {pendingDeleteItem?.annotation_count ?? 0} 条标注会一并删除。
          图库中的原始素材保留，可重新加入其它空间。
        </p>
      </Modal>

      <Modal
        open={pendingDeleteSpace}
        title="删除空间"
        onClose={() => setPendingDeleteSpace(false)}
        footer={
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPendingDeleteSpace(false)}
            >
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void deleteSpace()}>
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将删除空间「{space.name}」及其中全部 {items.length} 张图片与 {totalAnnotations} 条标注，
          所有协作者都会失去访问权；图库中的原始素材不会被删除。
        </p>
      </Modal>
    </div>
  );
}
