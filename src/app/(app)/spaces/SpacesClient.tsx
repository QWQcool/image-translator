'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import Modal from '@/components/Modal';
import ProgressBadge from '@/components/ProgressBadge';
import TagPicker from '@/components/TagPicker';
import { useStaggerReveal } from '@/lib/motion';
import { formatDate, thumbUrl } from '@/lib/media';
import {
  PROGRESS_BADGE_CLASS,
  PROGRESS_LABEL,
  SPACE_PROGRESS_VALUES,
  formatProgressAge,
  type SpaceProgress,
} from '@/lib/progress';
import { PRESET_TAGS, parseSpaceTags } from '@/lib/tags';
import type { SpaceRole, SpaceVisibility, SpaceWithCounts } from '@/lib/types';

type Draft = {
  id?: number;
  name: string;
  description: string;
  tags: string[];
  visibility: SpaceVisibility;
};

const EMPTY_DRAFT: Draft = { name: '', description: '', tags: [], visibility: 'private' };

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
  // 全局查找：LIKE 匹配空间名 / 描述 / 序号（走 API q 参数）
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // 多维筛选：进度（多选并集）
  const [progressFilter, setProgressFilter] = useState<Set<SpaceProgress>>(() => new Set());
  // 多维筛选：标签（多选并集，含任一标签即命中）
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => new Set());
  // 多维筛选：保存时间（任意 / 相对窗口 / 自定义日期，取该日 00:00 之前保存的）
  const [savedFilter, setSavedFilter] = useState<'any' | '3d' | '7d' | '30d' | 'custom'>('any');
  const [customDate, setCustomDate] = useState('');
  // 全库出现过的标签（服务端 distinct tags），预设之外的动态筛选候选
  const [distinctTags, setDistinctTags] = useState<string[]>([]);
  // 卡片入场：数据到达/筛选变化时逐张上浮
  const gridScope = useStaggerReveal('.space-card', [spaces.length, debouncedQuery, loading]);

  // 自定义日期只有合法（YYYY-MM-DD）才作为筛选条件发出
  const savedBeforeParam =
    savedFilter === '3d' || savedFilter === '7d' || savedFilter === '30d'
      ? savedFilter
      : savedFilter === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(customDate)
        ? customDate
        : '';

  const load = useCallback(
    async (opts: { q: string; progress: string[]; tags: string[]; savedBefore?: string }) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (opts.q) params.set('q', opts.q);
        if (opts.progress.length > 0) params.set('progress', opts.progress.join(','));
        if (opts.tags.length > 0) params.set('tag', opts.tags.join(','));
        if (opts.savedBefore) params.set('savedBefore', opts.savedBefore);
        const suffix = params.toString();
        const res = await fetch(`/api/spaces${suffix ? `?${suffix}` : ''}`);
        const data = await res.json();
        setSpaces(Array.isArray(data.spaces) ? data.spaces : []);
        if (Array.isArray(data.distinctTags)) setDistinctTags(data.distinctTags);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void load({
      q: debouncedQuery,
      progress: [...progressFilter],
      tags: [...tagFilter],
      savedBefore: savedBeforeParam,
    });
  }, [debouncedQuery, progressFilter, tagFilter, savedBeforeParam, load]);

  function toggleProgressFilter(value: SpaceProgress) {
    setProgressFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function toggleTagFilter(tag: string) {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  /** 是否有任一筛选生效（控制「清空筛选」按钮显隐） */
  const hasFilter =
    progressFilter.size > 0 || tagFilter.size > 0 || savedFilter !== 'any' || customDate !== '';

  function clearFilters() {
    setProgressFilter(new Set());
    setTagFilter(new Set());
    setSavedFilter('any');
    setCustomDate('');
  }

  // 筛选候选标签：预设在前，库内动态标签去重补后
  const tagOptions = [...new Set([...PRESET_TAGS, ...distinctTags])];

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
        tags: draft.tags,
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
      await load({
        q: debouncedQuery,
        progress: [...progressFilter],
        tags: [...tagFilter],
        savedBefore: savedBeforeParam,
      });
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
    await load({
      q: debouncedQuery,
      progress: [...progressFilter],
      tags: [...tagFilter],
      savedBefore: savedBeforeParam,
    });
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
    <div ref={gridScope} className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          新建空间
        </button>
        <span className="text-sm text-ink-500">共 {spaces.length} 个可见空间</span>
        <input
          className="input ml-auto w-56 py-1.5 text-xs"
          placeholder="搜索空间名称 / 描述 / 序号…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* 多维筛选：进度 chips + 标签 chips + 保存时间下拉，组合生效（并集） */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-400">进度</span>
          {SPACE_PROGRESS_VALUES.map((value) => {
            const on = progressFilter.has(value);
            return (
              <button
                key={value}
                type="button"
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  on
                    ? PROGRESS_BADGE_CLASS[value]
                    : 'bg-paper text-ink-400 ring-1 ring-ink-700 hover:text-ink-200'
                }`}
                onClick={() => toggleProgressFilter(value)}
              >
                {PROGRESS_LABEL[value]}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-400">标签</span>
          {tagOptions.map((tag) => {
            const on = tagFilter.has(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                  on
                    ? 'bg-sky/15 text-sky-deep ring-1 ring-sky/40'
                    : 'bg-paper text-ink-400 ring-1 ring-ink-700 hover:text-ink-200'
                }`}
                onClick={() => toggleTagFilter(tag)}
              >
                {tag}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-400">
          保存时间
          <select
            className="input py-1 text-xs"
            value={savedFilter}
            onChange={(e) =>
              setSavedFilter(e.target.value as 'any' | '3d' | '7d' | '30d' | 'custom')
            }
          >
            <option value="any">任意</option>
            <option value="3d">3 天前</option>
            <option value="7d">7 天前</option>
            <option value="30d">30 天前</option>
            <option value="custom">自定义</option>
          </select>
          {savedFilter === 'custom' && (
            <input
              type="date"
              className="input py-1 text-xs"
              value={customDate}
              title="显示该日 00:00 之前保存的空间"
              onChange={(e) => setCustomDate(e.target.value)}
            />
          )}
        </label>
        {hasFilter && (
          <button
            type="button"
            className="text-xs text-ink-400 underline hover:text-ink-200"
            onClick={clearFilters}
          >
            清空筛选
          </button>
        )}
      </div>

      {error && <p className="notice-error">{error}</p>}

      {loading ? (
        <p className="py-20 text-center text-sm text-ink-500">加载中…</p>
      ) : spaces.length === 0 ? (
        <EmptyState
          showMascot
          kaomoji={debouncedQuery ? '(・・?)' : '(´∀｀)♡'}
          title={debouncedQuery ? '没有匹配的空间' : '还没有空间'}
          hint={debouncedQuery ? '换个关键词试试' : '新建一个空间，进入后直接上传图片'}
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
                  className="card momentum-stripes hover-lift space-card group overflow-hidden"
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
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Link
                          href={`/spaces/${space.id}`}
                          className="truncate text-sm font-medium text-ink-100 hover:text-sky-deep"
                        >
                          {space.name}
                        </Link>
                        {/* 空间序号：等宽小徽标，历史空间无序号不显示 */}
                        {space.space_no && (
                          <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
                            {space.space_no}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {/* 七级进度徽标：配色梯度，hover 显示维持时长 */}
                        <ProgressBadge progress={space.progress} progressAt={space.progress_at} />
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] ${
                            ROLE_BADGE[space.role].className
                          }`}
                        >
                          {ROLE_BADGE[space.role].label}
                        </span>
                      </div>
                    </div>

                    <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-xs text-ink-500">
                      {space.description || '还没写简介'}
                    </p>

                    {/* 标签：最多展示 3 个，超出用 +n 收起 */}
                    {parseSpaceTags(space.tags).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {parseSpaceTags(space.tags)
                          .slice(0, 3)
                          .map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-sky/10 px-1.5 py-0.5 text-[10px] text-sky-deep"
                            >
                              {tag}
                            </span>
                          ))}
                        {parseSpaceTags(space.tags).length > 3 && (
                          <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
                            +{parseSpaceTags(space.tags).length - 3}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="mt-3 flex items-center justify-between text-[11px] text-ink-400">
                      <span>
                        {space.item_count} 图 · {space.annotation_count} 标注
                        {/* 维持时长小字：进入当前进度至今 */}
                        {formatProgressAge(space.progress_at) &&
                          ` · 已维持 ${formatProgressAge(space.progress_at)}`}
                      </span>
                      <span>{formatDate(space.updated_at)}</span>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-400">
                      <span>🌐 公共文件夹（登录用户可编辑）</span>
                      <span>创建者：{space.owner_name ?? '—'}</span>
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
                              tags: parseSpaceTags(space.tags),
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
                      {/* 权限扁平化：登录即可删除，不再限创建者 */}
                      {space.can_edit && (
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
            <label className="label">标签</label>
            <TagPicker
              selected={draft?.tags ?? []}
              onChange={(tags) => setDraft((d) => (d ? { ...d, tags } : d))}
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
          <p className="rounded-lg bg-sky/10 px-3 py-2 text-[11px] leading-relaxed text-ink-500">
            📁 文件夹对所有登录用户开放：人人可看、可编辑、可删除
          </p>
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
          {pendingDelete?.annotation_count ?? 0} 条标注，所有协作者都会失去访问权，
          <strong className="text-blush">此操作不可撤销</strong>。
        </p>
      </Modal>
    </div>
  );
}
