'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import { formatDate, thumbUrl } from '@/lib/media';
import type { SpaceRole, SpaceVisibility, SpaceWithCounts } from '@/lib/types';

type Draft = { id?: number; name: string; description: string; visibility: SpaceVisibility };

const EMPTY_DRAFT: Draft = { name: '', description: '', visibility: 'private' };

const ROLE_BADGE: Record<SpaceRole, { label: string; className: string }> = {
  owner: { label: '所有者', className: 'bg-sky/15 text-sky-deep' },
  editor: { label: '可编辑', className: 'bg-emerald-500/15 text-emerald-700' },
  viewer: { label: '只读', className: 'bg-ink-800 text-ink-400' },
};

export default function SpacesClient() {
  const [spaces, setSpaces] = useState<SpaceWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SpaceWithCounts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/spaces');
      const data = await res.json();
      setSpaces(Array.isArray(data.spaces) ? data.spaces : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError('请填写空间名称');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        description: draft.description.trim() || null,
        visibility: draft.visibility,
      };
      const res = draft.id
        ? await fetch(`/api/spaces/${draft.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/spaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存失败');
        return;
      }
      setDraft(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    const res = await fetch(`/api/spaces/${target.id}`, { method: 'DELETE' });
    if (!res.ok) {
      setError('删除失败');
      return;
    }
    await load();
  }

  const groups = [
    { key: 'owned', label: '我创建的', items: spaces.filter((s) => s.is_owner) },
    {
      key: 'collab',
      label: '协作给我的',
      items: spaces.filter((s) => !s.is_owner && s.can_edit),
    },
    { key: 'readonly', label: '只读', items: spaces.filter((s) => !s.can_edit) },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          新建空间
        </button>
        <span className="text-sm text-ink-500">共 {spaces.length} 个可见空间</span>
      </div>

      {error && <p className="notice-error">{error}</p>}

      {loading ? (
        <p className="py-20 text-center text-sm text-ink-500">加载中…</p>
      ) : spaces.length === 0 ? (
        <EmptyState
          showMascot
          kaomoji="(´∀｀)♡"
          title="还没有空间"
          hint="新建一个空间，然后去「图库」把图片加进来"
        />
      ) : (
        groups.map((group) => (
          <section key={group.key}>
            <h2 className="mb-3 text-sm font-medium text-ink-200">
              {group.label}
              <span className="ml-1.5 text-ink-400">{group.items.length}</span>
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {group.items.map((space) => (
                <div
                  key={space.id}
                  className="card group overflow-hidden transition-colors hover:border-sky/35"
                >
                  <Link href={`/spaces/${space.id}`} className="block">
                    <div className="aspect-[16/10] w-full overflow-hidden bg-paper">
                      {space.cover_thumb || space.cover_filename ? (
                        <img
                          src={thumbUrl(space.cover_thumb, space.cover_filename ?? '')}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-3xl opacity-40">
                          🗂️
                        </div>
                      )}
                    </div>
                  </Link>

                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/spaces/${space.id}`}
                        className="truncate text-sm font-medium text-ink-100 hover:text-sky-deep"
                      >
                        {space.name}
                      </Link>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                          ROLE_BADGE[space.role].className
                        }`}
                      >
                        {ROLE_BADGE[space.role].label}
                      </span>
                    </div>

                    <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-xs text-ink-500">
                      {space.description || '还没写简介'}
                    </p>

                    <div className="mt-3 flex items-center justify-between text-[11px] text-ink-400">
                      <span>
                        {space.item_count} 图 · {space.annotation_count} 标注
                      </span>
                      <span>{formatDate(space.updated_at)}</span>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-400">
                      <span>
                        {space.visibility === 'public' ? '🌐 公开（登录用户可见）' : '🔒 仅成员可见'}
                      </span>
                      <span>{space.member_count} 成员</span>
                    </div>

                    <div className="mt-3 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                      {space.can_edit ? (
                        <button
                          type="button"
                          className="btn-ghost flex-1 py-1 text-xs"
                          onClick={() =>
                            setDraft({
                              id: space.id,
                              name: space.name,
                              description: space.description ?? '',
                              visibility: space.visibility,
                            })
                          }
                        >
                          编辑
                        </button>
                      ) : (
                        <span className="flex-1 py-1 text-center text-xs text-ink-400">
                          只读权限
                        </span>
                      )}
                      {space.is_owner && (
                        <button
                          type="button"
                          className="btn-danger flex-1 py-1 text-xs"
                          onClick={() => setPendingDelete(space)}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      <Modal
        open={draft !== null}
        title={draft?.id ? '编辑空间' : '新建空间'}
        onClose={() => setDraft(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={saving}
              onClick={() => void saveDraft()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="space-name">
              名称
            </label>
            <input
              id="space-name"
              className="input"
              value={draft?.name ?? ''}
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
              placeholder="例如：2026 春季活动"
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="space-desc">
              描述（可选）
            </label>
            <textarea
              id="space-desc"
              className="input min-h-[80px] resize-y"
              value={draft?.description ?? ''}
              onChange={(e) => setDraft((d) => (d ? { ...d, description: e.target.value } : d))}
              placeholder="简单说明这个空间收集什么内容"
            />
          </div>
          <div>
            <span className="label">可见性</span>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: 'private', title: '仅成员可见', hint: '只有通过邀请加入的人能访问' },
                  { value: 'public', title: '公开', hint: '所有登录用户可见，但非成员只能查看' },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setDraft((d) => (d ? { ...d, visibility: option.value } : d))}
                  className={`rounded-lg border p-2.5 text-left transition-colors ${
                    draft?.visibility === option.value
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
          {error && <p className="text-sm text-blush">{error}</p>}
        </div>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        title="删除空间"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setPendingDelete(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p className="text-sm text-ink-200">
          将删除空间「{pendingDelete?.name}」及其中的 {pendingDelete?.item_count ?? 0} 张图片与{' '}
          {pendingDelete?.annotation_count ?? 0} 条标注，所有协作者都会失去访问权。
          图库中的原始素材不会被删除。
        </p>
      </Modal>
    </div>
  );
}
