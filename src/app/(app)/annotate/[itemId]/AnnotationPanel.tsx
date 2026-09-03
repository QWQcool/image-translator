'use client';

import EmptyState from '@/components/EmptyState';
import { mergeBgColor, splitBgColor, type DraftAnnotation } from '@/lib/annotation';

const ALIGN_OPTIONS: Array<{ value: DraftAnnotation['align']; label: string }> = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' },
];

export default function AnnotationPanel({
  annotations,
  selectedKey,
  selectedKeys,
  onToggleDoubtful,
  imageHeight,
  onSelect,
  onChange,
  onRemove,
  readOnly,
}: {
  annotations: DraftAnnotation[];
  selectedKey: string | null;
  /** 多选集合（含 selectedKey），在集合内的卡片都高亮 */
  selectedKeys?: string[];
  /** 存疑切换（单张） */
  onToggleDoubtful?: (key: string) => void;
  imageHeight: number;
  onSelect: (key: string) => void;
  onChange: (next: DraftAnnotation[]) => void;
  onRemove: (key: string) => void;
  readOnly: boolean;
}) {
  function patch(key: string, updates: Partial<DraftAnnotation>) {
    onChange(annotations.map((item) => (item.key === key ? { ...item, ...updates } : item)));
  }

  if (annotations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
      <EmptyState
        padded={false}
        kaomoji="(´∀｀)♡"
        title="还没有标注"
        hint={
          readOnly ? (
            '你在该空间是只读权限，无法添加标注。'
          ) : (
            <>
              在左侧图片上按住左键拖出一个方框，
              <br />
              然后在右侧输入文字。
            </>
          )
        }
      />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {annotations.map((annotation, index) => {
        const active = annotation.key === selectedKey || (selectedKeys?.includes(annotation.key) ?? false);
        const bg = splitBgColor(annotation.bg_color);
        const fontSizePx = Math.round(annotation.font_size_ratio * imageHeight);

        return (
          <div
            key={annotation.key}
            onMouseDown={() => onSelect(annotation.key)}
            className={`rounded-lg border p-3 transition-colors ${
              active ? 'border-sky bg-sky/5' : 'border-ink-700 bg-cloud'
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-200">#{index + 1}</span>
              <div className="flex items-center gap-2 text-[11px] text-ink-500">
                <span>
                  {Math.round(annotation.x * 100)}, {Math.round(annotation.y * 100)} ·{' '}
                  {Math.round(annotation.w * 100)}×{Math.round(annotation.h * 100)}
                </span>
                {/* 存疑徽标 + 切换按钮 */}
                {!readOnly && onToggleDoubtful && (
                  <button
                    type="button"
                    onClick={() => onToggleDoubtful(annotation.key)}
                    title="标记 / 取消存疑（Alt+X）"
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      annotation.doubtful
                        ? 'bg-amber-500/20 font-medium text-amber-600'
                        : 'text-ink-500 hover:bg-ink-700/40 hover:text-ink-200'
                    }`}
                  >
                    存疑
                  </button>
                )}
                {/* 只读时无切换按钮，用静态徽标展示状态（可编辑态由上方按钮承担） */}
                {readOnly && annotation.doubtful && (
                  <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                    存疑
                  </span>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onRemove(annotation.key)}
                    className="rounded px-1 text-blush hover:bg-blush/15"
                  >
                    删除
                  </button>
                )}
              </div>
            </div>

            <textarea
              className="input min-h-[68px] resize-y text-xs disabled:opacity-60"
              placeholder={readOnly ? '（只读）' : '输入要显示在图片上的文字…'}
              value={annotation.text}
              disabled={readOnly}
              onChange={(event) =>
                patch(annotation.key, { text: event.target.value, runs: null })
              }
              onFocus={() => onSelect(annotation.key)}
            />

            <div className="mt-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[11px] text-ink-500">字号</span>
                <input
                  type="range"
                  min={0.004}
                  max={0.2}
                  step={0.001}
                  value={annotation.font_size_ratio}
                  disabled={readOnly}
                  onChange={(event) =>
                    patch(annotation.key, { font_size_ratio: Number(event.target.value) })
                  }
                  className="h-1 flex-1 accent-sky"
                />
                <span className="w-11 shrink-0 text-right text-[11px] text-ink-400">
                  {fontSizePx}px
                </span>
              </div>

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
                  文字
                  <input
                    type="color"
                    value={annotation.color}
                    disabled={readOnly}
                    onChange={(event) => patch(annotation.key, { color: event.target.value })}
                    className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent disabled:cursor-default"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
                  底色
                  <input
                    type="color"
                    value={bg.hex}
                    disabled={readOnly}
                    onChange={(event) =>
                      patch(annotation.key, { bg_color: mergeBgColor(event.target.value, bg.alpha) })
                    }
                    className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent disabled:cursor-default"
                  />
                </label>
                <label className="flex flex-1 items-center gap-1.5 text-[11px] text-ink-500">
                  透明
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={bg.alpha}
                    disabled={readOnly}
                    onChange={(event) =>
                      patch(annotation.key, {
                        bg_color: mergeBgColor(bg.hex, Number(event.target.value)),
                      })
                    }
                    className="h-1 flex-1 accent-sky"
                  />
                </label>
              </div>

              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[11px] text-ink-500">不透明</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round((annotation.text_opacity ?? 1) * 100)}
                  disabled={readOnly}
                  onChange={(event) =>
                    patch(annotation.key, { text_opacity: Number(event.target.value) / 100 })
                  }
                  className="h-1 flex-1 accent-sky"
                />
                <span className="w-9 shrink-0 text-right text-[11px] text-ink-400">
                  {Math.round((annotation.text_opacity ?? 1) * 100)}%
                </span>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex overflow-hidden rounded-md border border-ink-700">
                  {ALIGN_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      disabled={readOnly}
                      onClick={() => patch(annotation.key, { align: option.value })}
                      className={`px-2 py-0.5 text-[11px] transition-colors disabled:opacity-60 ${
                        annotation.align === option.value
                          ? 'bg-sky text-white'
                          : 'text-ink-400 hover:text-ink-200'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="flex overflow-hidden rounded-md border border-ink-700">
                  {[400, 700].map((weight) => (
                    <button
                      key={weight}
                      type="button"
                      disabled={readOnly}
                      onClick={() => patch(annotation.key, { font_weight: weight })}
                      className={`px-2 py-0.5 text-[11px] transition-colors disabled:opacity-60 ${
                        annotation.font_weight === weight
                          ? 'bg-sky text-white'
                          : 'text-ink-400 hover:text-ink-200'
                      }`}
                      style={{ fontWeight: weight }}
                    >
                      {weight === 700 ? '粗' : '细'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
