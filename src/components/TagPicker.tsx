'use client';

import { useEffect, useState } from 'react';
import { MAX_TAG_LENGTH, MAX_TAGS, PRESET_TAGS } from '@/lib/tags';

type Props = {
  /** 当前已选标签 */
  selected: string[];
  /** 已选集合变化（父组件直接替换数组） */
  onChange: (tags: string[]) => void;
};

/**
 * 标签选择器：预设 chips + 自定义输入（回车确认）+ 已选 chips 点击移除。
 * 新建/编辑空间表单共用；自定义输入的标签会追加为本表单的自定义候选。
 * 预设候选从站点配置（/api/settings 的 preset_tags）读取，未配置过回落 PRESET_TAGS。
 */
export default function TagPicker({ selected, onChange }: Props) {
  // 自定义候选：预设之外、本表单里添加过的标签（随组件生命周期保留）
  const [customOptions, setCustomOptions] = useState<string[]>([]);
  const [input, setInput] = useState('');
  // 预设候选：先回落内置常量，挂载后拉站点配置覆盖
  const [preset, setPreset] = useState<readonly string[]>(PRESET_TAGS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.presetTags) && data.presetTags.length > 0) {
          setPreset(data.presetTags as string[]);
        }
      } catch {
        // 拉取失败保持内置默认
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = [...preset, ...customOptions.filter((tag) => !preset.includes(tag))];

  /** 添加标签：trim、截断、去重、上限校验；非预设的进自定义候选 */
  function addTag(raw: string) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || selected.includes(tag) || selected.length >= MAX_TAGS) return;
    if (!options.includes(tag)) setCustomOptions((prev) => [...prev, tag]);
    onChange([...selected, tag]);
    setInput('');
  }

  function removeTag(tag: string) {
    onChange(selected.filter((item) => item !== tag));
  }

  const chipOn =
    'rounded-full bg-sky/15 px-2.5 py-0.5 text-xs text-sky-deep ring-1 ring-sky/40';
  const chipOff =
    'rounded-full bg-paper px-2.5 py-0.5 text-xs text-ink-400 ring-1 ring-ink-700 transition-colors hover:text-ink-200';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {options.map((tag) => {
          const on = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              className={on ? chipOn : chipOff}
              onClick={() => (on ? removeTag(tag) : addTag(tag))}
            >
              {tag}
            </button>
          );
        })}
      </div>
      <input
        className="input py-1.5 text-xs"
        placeholder={`自定义标签，回车添加（每个 ≤${MAX_TAG_LENGTH} 字，最多 ${MAX_TAGS} 个）`}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addTag(input);
          }
        }}
      />
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-400">已选 {selected.length}：</span>
          {selected.map((tag) => (
            <button
              key={tag}
              type="button"
              title="点击移除"
              className={chipOn}
              onClick={() => removeTag(tag)}
            >
              {tag} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
