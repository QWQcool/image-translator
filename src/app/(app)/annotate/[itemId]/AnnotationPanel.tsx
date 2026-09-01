'use client';

import { mergeBgColor, splitBgColor, type DraftAnnotation } from '@/lib/annotation';

const ALIGN_OPTIONS: Array<{ value: DraftAnnotation['align']; label: string }> = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' },
];

export default function AnnotationPanel({
  annotations,
  selectedKey,
  imageHeight,
  onSelect,
  onChange,
  onRemove,
  readOnly,
}: {
  annotations: DraftAnnotation[];
  selectedKey: string | null;
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
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <p className="text-sm text-ink-400">还没有标注</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            {readOnly ? (
              '你在该空间是只读权限，无法添加标注。'
            ) : (
              <>
                在左侧图片上按住左键拖出一个方框，
                <br />
                然后在右侧输入文字。
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {annotations.map((annotation, index) => {
        const active = annotation.key === selectedKey;
        const bg = splitBgColor(annotation.bg_color);
        const fontSizePx = Math.round(annotation.font_size_ratio * imageHeight);

        return (
          <div
            key={annotation.key}
            onMouseDown={() => onSelect(annotation.key)}
            className={`rounded-lg border p-3 transition-colors ${
              active ? 'border-brand-500 bg-brand-500/5' : 'border-ink-800 bg-ink-900/40'
            }`}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-300">#{index + 1}</span>
              <div className="flex items-center gap-2 text-[11px] text-ink-500">
                <span>
                  {Math.round(annotation.x * 100)}, {Math.round(annotation.y * 100)} ·{' '}
                  {Math.round(annotation.w * 100)}×{Math.round(annotation.h * 100)}
                </span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => onRemove(annotation.key)}
                    className="rounded px-1 text-red-400 hover:bg-red-950/60 hover:text-red-300"
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
              onChange={(event) => patch(annotation.key, { text: event.target.value })}
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
                  className="h-1 flex-1 accent-brand-500"
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
                    className="h-1 flex-1 accent-brand-500"
                  />
                </label>
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
                          ? 'bg-ink-700 text-white'
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
                          ? 'bg-ink-700 text-white'
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
