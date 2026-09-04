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
  SPACE_PROGRESS_VALUES,
  type SpaceProgress,
} from '@/lib/progress';
import { parseSpaceTags } from '@/lib/tags';
import { enabledProgressItems, progressLabelOf } from '@/lib/site-config';
import { useSiteConfig } from '@/lib/use-site-config';
import type { SpaceVisibility, SpaceWithCounts } from '@/lib/types';

type Draft = {
  id?: number;
  name: string;
  description: string;
  tags: string[];
  visibility: SpaceVisibility;
  author: string;
  translator: string;
  proofreader: string;
  typesetter: string;
};

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  tags: [],
  visibility: 'private',
  author: '',
  translator: '',
  proofreader: '',
  typesetter: '',
};

/** 「进行中」预设：除 typeset_done 外的六态（seg 快捷键对应的 progressSet） */
const ACTIVE_PRESET: readonly SpaceProgress[] = SPACE_PROGRESS_VALUES.filter(
  (value) => value !== 'typeset_done',
);

export default function SpacesClient() {
  const [spaces, setSpaces] = useState<SpaceWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SpaceWithCounts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 全局查找：LIKE 匹配空间名 / 描述 / 序号 / 制作人员（走 API q 参数）
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // 多维筛选：进度（多选并集）
  const [progressFilter, setProgressFilter] = useState<Set<SpaceProgress>>(() => new Set());
  // 多维筛选：标签（多选并集，含任一标签即命中）
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => new Set());
  // 多维筛选：制作人员独立筛选（作者 / 翻译 / 校对 / 嵌字）
  const [authorFilter, setAuthorFilter] = useState('');
  const [translatorFilter, setTranslatorFilter] = useState('');
  const [proofreaderFilter, setProofreaderFilter] = useState('');
  const [typesetterFilter, setTypesetterFilter] = useState('');
  // 多维筛选：保存时间（任意 / 相对窗口 / 自定义日期，取该日 00:00 之前保存的）
  const [savedFilter, setSavedFilter] = useState<'any' | '3d' | '7d' | '30d' | 'custom'>('any');
  const [customDate, setCustomDate] = useState('');
  // 全库出现过的标签（服务端 distinct tags），预设之外的动态筛选候选
  const [distinctTags, setDistinctTags] = useState<string[]>([]);
  // 筛选面板展开/收起
  const [panelOpen, setPanelOpen] = useState(false);
  // 筛选面板：自定义标签输入（回车添加为筛选条件，不必存在于任何空间）
  const [customTagFilterInput, setCustomTagFilterInput] = useState('');
  // 站点配置：进度项（label/enabled）与预设标签
  const { progressItems, presetTags } = useSiteConfig();
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
    async (opts: {
      q: string;
      progress: string[];
      tags: string[];
      savedBefore?: string;
      author?: string;
      translator?: string;
      proofreader?: string;
      typesetter?: string;
    }) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (opts.q) params.set('q', opts.q);
        if (opts.progress.length > 0) params.set('progress', opts.progress.join(','));
        if (opts.tags.length > 0) params.set('tag', opts.tags.join(','));
        if (opts.savedBefore) params.set('savedBefore', opts.savedBefore);
        if (opts.author) params.set('author', opts.author);
        if (opts.translator) params.set('translator', opts.translator);
        if (opts.proofreader) params.set('proofreader', opts.proofreader);
        if (opts.typesetter) params.set('typesetter', opts.typesetter);
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
      author: authorFilter.trim(),
      translator: translatorFilter.trim(),
      proofreader: proofreaderFilter.trim(),
      typesetter: typesetterFilter.trim(),
    });
  }, [
    debouncedQuery,
    progressFilter,
    tagFilter,
    savedBeforeParam,
    authorFilter,
    translatorFilter,
    proofreaderFilter,
    typesetterFilter,
    load,
  ]);

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
    progressFilter.size > 0 ||
    tagFilter.size > 0 ||
    savedFilter !== 'any' ||
    customDate !== '' ||
    authorFilter.trim() !== '' ||
    translatorFilter.trim() !== '' ||
    proofreaderFilter.trim() !== '' ||
    typesetterFilter.trim() !== '';

  // seg 快捷预设与 progressSet 联动：由当前 progressSet 反推命中的预设
  // （空=全部；六态全勾=进行中；仅已嵌字=已完结；其余=三个都不亮，筛选按钮高亮标记微调态）
  const segActive: 'all' | 'active' | 'done' | null =
    progressFilter.size === 0
      ? 'all'
      : progressFilter.size === ACTIVE_PRESET.length &&
          ACTIVE_PRESET.every((value) => progressFilter.has(value))
        ? 'active'
        : progressFilter.size === 1 && progressFilter.has('typeset_done')
          ? 'done'
          : null;

  // 筛选按钮 badge：seg 预设之外生效中的筛选数（标签数 + 保存时间 + 制作人员筛选 + 微调过的进度集合）
  const extraFilterCount =
    tagFilter.size +
    (savedBeforeParam ? 1 : 0) +
    (segActive === null ? 1 : 0) +
    (authorFilter.trim() ? 1 : 0) +
    (translatorFilter.trim() ? 1 : 0) +
    (proofreaderFilter.trim() ? 1 : 0) +
    (typesetterFilter.trim() ? 1 : 0);

  /** seg 快捷键：选中即把 progressSet 设为对应预设 */
  function applySeg(kind: 'all' | 'active' | 'done') {
    if (kind === 'all') setProgressFilter(new Set());
    else if (kind === 'active') setProgressFilter(new Set(ACTIVE_PRESET));
    else setProgressFilter(new Set<SpaceProgress>(['typeset_done']));
  }

  function clearFilters() {
    setProgressFilter(new Set());
    setTagFilter(new Set());
    setSavedFilter('any');
    setCustomDate('');
    setAuthorFilter('');
    setTranslatorFilter('');
    setProofreaderFilter('');
    setTypesetterFilter('');
  }

  // 筛选候选标签：站点配置预设在前，库内动态标签去重补后
  const tagOptions = [...new Set([...presetTags, ...distinctTags])];
  // 筛选面板的进度 chips：只列站点配置中启用中的进度项
  const filterProgressItems = enabledProgressItems(progressItems);
  // 单一网格：全部空间按 updated_at 倒序（不再按创建者/协作分组）
  const sortedSpaces = [...spaces].sort(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id,
  );

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
        author: draft.author.trim(),
        translator: draft.translator.trim(),
        proofreader: draft.proofreader.trim(),
        typesetter: draft.typesetter.trim(),
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
        author: authorFilter.trim(),
        translator: translatorFilter.trim(),
        proofreader: proofreaderFilter.trim(),
        typesetter: typesetterFilter.trim(),
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
      author: authorFilter.trim(),
      translator: translatorFilter.trim(),
      proofreader: proofreaderFilter.trim(),
      typesetter: typesetterFilter.trim(),
    });
  }

  return (
    <div ref={gridScope} className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
          新建空间
        </button>
        <span className="text-sm text-ink-500">共 {spaces.length} 个可见空间</span>
        <input
          className="input ml-auto w-64 py-1.5 text-xs"
          placeholder="搜索空间名称 / 描述 / 序号 / 制作人员…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {/* 简洁模式：seg 快捷预设（全部/进行中/已完结）+ 筛选按钮（展开多维面板） */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="seg">
          <button
            type="button"
            className={`seg-btn ${segActive === 'all' ? 'seg-btn-on' : ''}`}
            onClick={() => applySeg('all')}
          >
            全部
          </button>
          <button
            type="button"
            className={`seg-btn ${segActive === 'active' ? 'seg-btn-on' : ''}`}
            onClick={() => applySeg('active')}
          >
            进行中
          </button>
          <button
            type="button"
            className={`seg-btn ${segActive === 'done' ? 'seg-btn-on' : ''}`}
            onClick={() => applySeg('done')}
          >
            已完结
          </button>
        </div>
        <button
          type="button"
          title="展开/收起筛选面板"
          className={`btn-ghost py-1.5 text-xs ${segActive === null ? 'ring-2 ring-sky/50' : ''}`}
          onClick={() => setPanelOpen((v) => !v)}
        >
          筛选
          {extraFilterCount > 0 && (
            <span className="ml-1.5 rounded-full bg-sky px-1.5 text-[10px] leading-4 text-white">
              {extraFilterCount}
            </span>
          )}
        </button>
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

      {/* 筛选面板：进度七态 chips + 标签 chips/自定义 + 保存时间 + 制作人员（作者/翻译/校对/嵌字） */}
      {panelOpen && (
        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink-400">进度</span>
            {filterProgressItems.map((item) => {
              const on = progressFilter.has(item.key);
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    on
                      ? PROGRESS_BADGE_CLASS[item.key]
                      : 'bg-paper text-ink-400 ring-1 ring-ink-700 hover:text-ink-200'
                  }`}
                  onClick={() => toggleProgressFilter(item.key)}
                >
                  {item.label}
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
            <input
              className="input w-36 py-0.5 text-[11px]"
              placeholder="自定义标签，回车添加"
              value={customTagFilterInput}
              onChange={(e) => setCustomTagFilterInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const tag = customTagFilterInput.trim().slice(0, 12);
                  if (tag) {
                    toggleTagFilter(tag);
                    setCustomTagFilterInput('');
                  }
                }
              }}
            />
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

          {/* 制作人员独立自定义筛选 */}
          <div className="grid grid-cols-2 gap-2 border-t border-ink-800 pt-2.5 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-[11px] text-ink-400">
              作者
              <input
                className="input py-1 text-xs"
                placeholder="按作者筛选…"
                value={authorFilter}
                onChange={(e) => setAuthorFilter(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-400">
              翻译
              <input
                className="input py-1 text-xs"
                placeholder="按翻译筛选…"
                value={translatorFilter}
                onChange={(e) => setTranslatorFilter(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-400">
              校对
              <input
                className="input py-1 text-xs"
                placeholder="按校对筛选…"
                value={proofreaderFilter}
                onChange={(e) => setProofreaderFilter(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-400">
              嵌字
              <input
                className="input py-1 text-xs"
                placeholder="按嵌字筛选…"
                value={typesetterFilter}
                onChange={(e) => setTypesetterFilter(e.target.value)}
              />
            </label>
          </div>
        </div>
      )}

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {sortedSpaces.map((space) => (
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
                        {/* 七级进度徽标：配色梯度 + 维持时长外显（纯展示不可点，无纹理圈） */}
                        <ProgressBadge
                          progress={space.progress}
                          progressAt={space.progress_at}
                          showAge
                          label={progressLabelOf(progressItems, space.progress)}
                        />
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
                      </span>
                      <span>{formatDate(space.updated_at)}</span>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-400">
                      <span>🌐 公共文件夹（登录用户可编辑）</span>
                      <span>创建者：{space.owner_name ?? '—'}</span>
                    </div>

                    {(space.author || space.translator || space.proofreader || space.typesetter) && (
                      <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-ink-400">
                        {space.author && (
                          <span>
                            作者：<span className="text-ink-200">{space.author}</span>
                          </span>
                        )}
                        {space.translator && (
                          <span>
                            翻译：<span className="text-ink-200">{space.translator}</span>
                          </span>
                        )}
                        {space.proofreader && (
                          <span>
                            校对：<span className="text-ink-200">{space.proofreader}</span>
                          </span>
                        )}
                        {space.typesetter && (
                          <span>
                            嵌字：<span className="text-ink-200">{space.typesetter}</span>
                          </span>
                        )}
                      </div>
                    )}

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
                              author: space.author ?? '',
                              translator: space.translator ?? '',
                              proofreader: space.proofreader ?? '',
                              typesetter: space.typesetter ?? '',
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="space-author">
                作者
              </label>
              <input
                id="space-author"
                className="input text-xs"
                value={draft?.author ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, author: e.target.value } : d))}
                placeholder="原作者名"
              />
            </div>
            <div>
              <label className="label" htmlFor="space-translator">
                翻译
              </label>
              <input
                id="space-translator"
                className="input text-xs"
                value={draft?.translator ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, translator: e.target.value } : d))}
                placeholder="翻译担当"
              />
            </div>
            <div>
              <label className="label" htmlFor="space-proofreader">
                校对
              </label>
              <input
                id="space-proofreader"
                className="input text-xs"
                value={draft?.proofreader ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, proofreader: e.target.value } : d))}
                placeholder="校对担当"
              />
            </div>
            <div>
              <label className="label" htmlFor="space-typesetter">
                嵌字
              </label>
              <input
                id="space-typesetter"
                className="input text-xs"
                value={draft?.typesetter ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, typesetter: e.target.value } : d))}
                placeholder="嵌字担当"
              />
            </div>
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
