'use client';

import { useEffect, useState } from 'react';
import {
  DEFAULT_PRESET_TAGS,
  DEFAULT_PROGRESS_ITEMS,
  MAX_PRESET_TAG_LENGTH,
  MAX_PRESET_TAGS,
  MAX_PROGRESS_LABEL_LENGTH,
  type ProgressItem,
} from '@/lib/site-config';

/**
 * 站点设置页（登录即可访问）：
 * 卡片 1 进度项管理（内置七态：key 不可改 + label 输入 + enabled 开关）；
 * 卡片 2 默认标签管理（chips 增删 + 自定义输入）。
 * 改动即更新本地状态，「保存」按钮统一 PUT /api/settings。
 */
export default function SettingsPage() {
  const [progressItems, setProgressItems] = useState<ProgressItem[]>(DEFAULT_PROGRESS_ITEMS);
  const [presetTags, setPresetTags] = useState<string[]>([...DEFAULT_PRESET_TAGS]);
  const [customTag, setCustomTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 挂载时拉取现有配置（未配置过则保持内置默认展示）
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.progressItems) && data.progressItems.length > 0) {
            setProgressItems(data.progressItems as ProgressItem[]);
          }
          if (Array.isArray(data.presetTags)) setPresetTags(data.presetTags as string[]);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** 改动即更新本地状态（保存时才发 PUT） */
  function updateItem(key: ProgressItem['key'], patch: Partial<ProgressItem>) {
    setProgressItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  }

  /** 添加自定义预设标签：trim、截断 12 字、去重、上限 30 */
  function addCustomTag() {
    const tag = customTag.trim().slice(0, MAX_PRESET_TAG_LENGTH);
    if (!tag) return;
    if (presetTags.includes(tag)) {
      setError(`标签「${tag}」已存在`);
      return;
    }
    if (presetTags.length >= MAX_PRESET_TAGS) {
      setError(`预设标签最多 ${MAX_PRESET_TAGS} 个`);
      return;
    }
    setError(null);
    setPresetTags((prev) => [...prev, tag]);
    setCustomTag('');
  }

  /** 统一 PUT：发送当前本地状态（两项一起），用服务端清洗结果覆盖本地 */
  async function save(section: 'progress' | 'tags') {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progressItems, presetTags }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存失败');
        return;
      }
      if (Array.isArray(data.progressItems)) setProgressItems(data.progressItems as ProgressItem[]);
      if (Array.isArray(data.presetTags)) setPresetTags(data.presetTags as string[]);
      setNotice(section === 'progress' ? '进度项设置已保存' : '默认标签已保存');
    } catch {
      setError('网络异常，保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="py-20 text-center text-sm text-ink-500">加载中…</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-xl tracking-wide text-ink-100">站点设置</h1>
        <p className="mt-1 text-xs text-ink-400">站点级配置，所有登录用户共享（登录即可修改）</p>
      </div>

      {notice && <p className="notice-ok">{notice}</p>}
      {error && <p className="notice-error">{error}</p>}

      {/* 卡片 1：进度项管理 */}
      <section className="card p-5">
        <h2 className="text-sm font-medium text-ink-100">进度项管理</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
          进度档位固定为内置七态（不可增删）；可改显示名（≤{MAX_PROGRESS_LABEL_LENGTH}{' '}
          字）或停用。停用后不出现在详情页切换菜单与筛选 chips 中，
          已处于停用态的空间徽标照常显示（用此处的显示名）。
        </p>
        <div className="mt-3 divide-y divide-ink-700/50">
          {progressItems.map((item) => (
            <div key={item.key} className="flex items-center gap-3 py-2">
              {/* 内置 key：只读小字展示，不可改 */}
              <span className="w-44 shrink-0 font-mono text-[11px] text-ink-400">{item.key}</span>
              <input
                className="input w-40 py-1 text-xs"
                maxLength={MAX_PROGRESS_LABEL_LENGTH}
                value={item.label}
                placeholder="显示名"
                onChange={(e) => updateItem(item.key, { label: e.target.value })}
              />
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-ink-400">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(e) => updateItem(item.key, { enabled: e.target.checked })}
                />
                启用
              </label>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="btn-primary py-1.5 text-xs"
            disabled={saving}
            onClick={() => void save('progress')}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </section>

      {/* 卡片 2：默认标签管理 */}
      <section className="card p-5">
        <h2 className="text-sm font-medium text-ink-100">默认标签管理</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
          新建/编辑空间的预设候选标签（每项 ≤{MAX_PRESET_TAG_LENGTH} 字，最多 {MAX_PRESET_TAGS}{' '}
          个）。点 chips 上的 × 删除，输入框回车添加。
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {presetTags.map((tag) => (
            <button
              key={tag}
              type="button"
              title="点击移除"
              className="rounded-full bg-sky/15 px-2.5 py-0.5 text-xs text-sky-deep ring-1 ring-sky/40"
              onClick={() => setPresetTags((prev) => prev.filter((item) => item !== tag))}
            >
              {tag} ×
            </button>
          ))}
        </div>
        <input
          className="input mt-3 py-1.5 text-xs"
          placeholder={`自定义标签，回车添加（每个 ≤${MAX_PRESET_TAG_LENGTH} 字，最多 ${MAX_PRESET_TAGS} 个）`}
          value={customTag}
          onChange={(e) => setCustomTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustomTag();
            }
          }}
        />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="btn-primary py-1.5 text-xs"
            disabled={saving}
            onClick={() => void save('tags')}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </div>
  );
}
