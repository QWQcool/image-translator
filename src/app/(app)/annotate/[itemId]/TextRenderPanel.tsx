'use client';

import { useState } from 'react';
import { applyRunStyle, type DraftAnnotation, type TextRun } from '@/lib/annotation';

/**
 * 左侧「文字渲染」面板：框选模式且选中标注时显示。
 * 用只读文本域展示当前标注文字，用户鼠标选中一段后，
 * 可单独给这一段改颜色 / 字号倍率 / 粗细（runs 拆分与合并见 applyRunStyle）。
 */
export default function TextRenderPanel({
  annotation,
  readOnly,
  onChange,
}: {
  annotation: DraftAnnotation;
  readOnly: boolean;
  onChange: (patch: Partial<DraftAnnotation>) => void;
}) {
  // 选区：只读文本域内的 [selectionStart, selectionEnd)
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  function captureSelection(element: HTMLTextAreaElement) {
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    setRange(start < end ? { start, end } : null);
  }

  function applyStyle(patch: Partial<Omit<TextRun, 'text'>>) {
    if (readOnly || !range) return;
    onChange({ runs: applyRunStyle(annotation.runs, annotation.text, range.start, range.end, patch) });
  }

  const hasSelection = Boolean(range) && !readOnly;

  return (
    <div
      className="w-60 space-y-2 rounded-xl border border-halo/50 bg-cloud/95 p-3 shadow-xl backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-ink-100">文字渲染</p>
        <button
          type="button"
          className="text-[11px] text-ink-400 hover:text-ink-100"
          title={annotation.runs ? '把全部分段合并回单段（清除段落样式）' : '没有段落样式'}
          disabled={readOnly || !annotation.runs}
          onClick={() => onChange({ runs: null })}
        >
          清除段落样式
        </button>
      </div>

      <textarea
        readOnly
        className="input min-h-[64px] resize-y text-xs"
        value={annotation.text}
        placeholder="选中下面文字的一段，再套用样式"
        onSelect={(event) => captureSelection(event.currentTarget)}
        onKeyUp={(event) => captureSelection(event.currentTarget)}
      />

      <p className="text-[11px] text-ink-500">
        {range
          ? `已选中 ${range.end - range.start} 字`
          : '用鼠标在上方文字里选中一段（未选中时控件不可用）'}
      </p>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
          颜色
          <input
            type="color"
            disabled={!hasSelection}
            onChange={(event) => applyStyle({ color: event.target.value })}
            className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent disabled:cursor-default disabled:opacity-50"
          />
        </label>
        <div className="flex overflow-hidden rounded-md border border-ink-700">
          {([400, 700] as const).map((weight) => (
            <button
              key={weight}
              type="button"
              disabled={!hasSelection}
              onClick={() => applyStyle({ fontWeight: weight })}
              className={`px-2 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                weight === 700 ? 'font-bold' : ''
              } hover:bg-sky/20`}
              style={{ fontWeight: weight }}
              title={`${weight === 700 ? '粗' : '细'}体（只作用于选中段）`}
            >
              {weight === 700 ? '粗' : '细'}
            </button>
          ))}
        </div>
      </div>

      <label className="block text-[11px] text-ink-500">
        字号倍率{range ? '' : '（选中后可用）'}
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          defaultValue={1}
          disabled={!hasSelection}
          onMouseUp={(event) => applyStyle({ fontSizeRatio: Number(event.currentTarget.value) })}
          onKeyUp={(event) => applyStyle({ fontSizeRatio: Number(event.currentTarget.value) })}
          className="mt-1 w-full accent-sky disabled:opacity-50"
        />
      </label>
      <p className="text-[11px] text-ink-400">
        相对标注级字号 0.5x ~ 2x；拖动结束（松开/松键）时套用到选中段。
      </p>
    </div>
  );
}
