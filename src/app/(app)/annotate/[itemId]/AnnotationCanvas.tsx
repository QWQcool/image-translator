'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp01, layoutText, type DraftAnnotation } from '@/lib/annotation';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

const CURSOR_BY_HANDLE: Record<Handle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 8;

/** 把标注绘制到任意分辨率的画布上，标注坐标全部是相对图片的归一化值 */
function paint(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  width: number,
  height: number,
  annotations: DraftAnnotation[],
  extra?: DraftAnnotation,
) {
  ctx.clearRect(0, 0, width, height);
  if (img) ctx.drawImage(img, 0, 0, width, height);

  const all = extra ? [...annotations, extra] : annotations;
  for (const annotation of all) {
    const x = annotation.x * width;
    const y = annotation.y * height;
    const w = annotation.w * width;
    const h = annotation.h * height;
    if (w <= 1 || h <= 1) continue;

    const padding = Math.min(6, w * 0.08);
    ctx.fillStyle = annotation.bg_color;
    ctx.fillRect(x, y, w, h);

    const text = annotation.text.trim();
    if (!text) continue;

    const { lines, fontSize, lineHeight } = layoutText(
      ctx,
      text,
      Math.max(8, w - padding * 2),
      annotation.font_weight,
      annotation.font_size_ratio * height,
      Math.max(8, h - padding * 2),
    );

    ctx.fillStyle = annotation.color;
    ctx.textBaseline = 'top';
    const blockHeight = lines.length * lineHeight;
    let cursorY = y + (h - blockHeight) / 2;

    for (const line of lines) {
      const lineWidth = ctx.measureText(line).width;
      let cursorX = x + padding;
      if (annotation.align === 'center') cursorX = x + (w - lineWidth) / 2;
      else if (annotation.align === 'right') cursorX = x + w - padding - lineWidth;
      ctx.fillText(line, cursorX, cursorY);
      cursorY += lineHeight;
    }
  }
}

export default function AnnotationCanvas({
  imageSrc,
  imageWidth,
  imageHeight,
  annotations,
  selectedKey,
  onSelect,
  onChange,
  fileName,
  readOnly,
}: {
  imageSrc: string;
  imageWidth: number;
  imageHeight: number;
  annotations: DraftAnnotation[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onChange: (next: DraftAnnotation[]) => void;
  fileName: string;
  readOnly: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [base, setBase] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);

  const dragRef = useRef<{
    mode: 'none' | 'pan' | 'draw' | 'move' | 'resize';
    key?: string;
    handle?: Handle;
    start: { x: number; y: number };
    startPan: { x: number; y: number };
    snapshot?: DraftAnnotation;
  }>({ mode: 'none', start: { x: 0, y: 0 }, startPan: { x: 0, y: 0 } });

  // 标注数据的最新引用，供高频指针事件读取而不重复绑定回调
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    const element = new Image();
    element.onload = () => setImg(element);
    element.src = imageSrc;
  }, [imageSrc]);

  /** 计算图片适应视口后的基准显示尺寸 */
  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !imageWidth || !imageHeight) return;
    const rect = viewport.getBoundingClientRect();
    const padding = 28;
    const scale = Math.min(
      (rect.width - padding * 2) / imageWidth,
      (rect.height - padding * 2) / imageHeight,
      1,
    );
    const next = {
      w: Math.max(1, Math.round(imageWidth * scale)),
      h: Math.max(1, Math.round(imageHeight * scale)),
    };
    setBase(next);
    setZoom(1);
    setPan({
      x: Math.round((rect.width - next.w) / 2),
      y: Math.round((rect.height - next.h) / 2),
    });
  }, [imageWidth, imageHeight]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => fitToViewport());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitToViewport]);

  // 重绘
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !base.w || !base.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(base.w * zoom * dpr);
    const pixelHeight = Math.round(base.h * zoom * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${base.w}px`;
    canvas.style.height = `${base.h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, 0, 0);
    paint(ctx, img, base.w, base.h, annotations, draft ?? undefined);
  }, [annotations, draft, base, zoom, img]);

  // 滚轮缩放（必须走原生监听，React 的 onWheel 是被动监听无法阻止页面滚动）
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      setZoom((current) => {
        const next = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)),
        );
        setPan((p) => ({
          x: mx - (mx - p.x) * (next / current),
          y: my - (my - p.y) * (next / current),
        }));
        return next;
      });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceDown(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  function stageCoords(event: { clientX: number; clientY: number }) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return { x: 0, y: 0 };
    const rect = wrapper.getBoundingClientRect();
    const currentZoom = zoomRef.current || 1;
    return {
      x: (event.clientX - rect.left) / currentZoom,
      y: (event.clientY - rect.top) / currentZoom,
    };
  }

  function hitTest(point: { x: number; y: number }): DraftAnnotation | null {
    const nx = point.x / base.w;
    const ny = point.y / base.h;
    for (let i = annotationsRef.current.length - 1; i >= 0; i -= 1) {
      const annotation = annotationsRef.current[i];
      if (
        nx >= annotation.x &&
        nx <= annotation.x + annotation.w &&
        ny >= annotation.y &&
        ny <= annotation.y + annotation.h
      ) {
        return annotation;
      }
    }
    return null;
  }

  function onPointerDown(event: React.PointerEvent) {
    if (!base.w) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const panning = event.button === 1 || spaceDown || event.altKey;
    if (panning) {
      dragRef.current = {
        mode: 'pan',
        start: { x: event.clientX, y: event.clientY },
        startPan: pan,
      };
      wrapper.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    // 只读模式下左键不产生任何编辑行为，但平移缩放仍可用
    if (readOnly) return;

    const point = stageCoords(event);
    const hit = hitTest(point);

    if (hit) {
      onSelect(hit.key);
      dragRef.current = {
        mode: 'move',
        key: hit.key,
        start: point,
        startPan: pan,
        snapshot: { ...hit },
      };
    } else {
      onSelect(null);
      dragRef.current = {
        mode: 'draw',
        start: point,
        startPan: pan,
      };
    }
    wrapper.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (drag.mode === 'none' || !base.w) return;

    if (drag.mode === 'pan') {
      setPan({
        x: drag.startPan.x + (event.clientX - drag.start.x),
        y: drag.startPan.y + (event.clientY - drag.start.y),
      });
      return;
    }

    const point = stageCoords(event);

    if (drag.mode === 'draw') {
      const x0 = clamp01(drag.start.x / base.w);
      const y0 = clamp01(drag.start.y / base.h);
      const x1 = clamp01(point.x / base.w);
      const y1 = clamp01(point.y / base.h);
      setDraft({
        key: '__draft__',
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
        text: '',
        font_size_ratio: 0.035,
        color: '#FFFFFF',
        bg_color: '#00000000',
        align: 'left',
        font_weight: 700,
      });
      return;
    }

    if (drag.mode === 'move' && drag.snapshot) {
      const dx = (point.x - drag.start.x) / base.w;
      const dy = (point.y - drag.start.y) / base.h;
      const snap = drag.snapshot;
      const x = clamp01(Math.min(snap.x + dx, 1 - snap.w));
      const y = clamp01(Math.min(snap.y + dy, 1 - snap.h));
      onChange(
        annotationsRef.current.map((item) =>
          item.key === drag.key ? { ...item, x, y } : item,
        ),
      );
      return;
    }

    if (drag.mode === 'resize' && drag.snapshot && drag.handle) {
      const snap = drag.snapshot;
      const dx = (point.x - drag.start.x) / base.w;
      const dy = (point.y - drag.start.y) / base.h;
      let { x, y, w, h } = snap;
      const handle = drag.handle;

      if (handle.includes('w')) {
        x = snap.x + dx;
        w = snap.w - dx;
      }
      if (handle.includes('e')) w = snap.w + dx;
      if (handle.includes('n')) {
        y = snap.y + dy;
        h = snap.h - dy;
      }
      if (handle.includes('s')) h = snap.h + dy;

      if (w < 0) {
        x += w;
        w = -w;
      }
      if (h < 0) {
        y += h;
        h = -h;
      }
      x = clamp01(x);
      y = clamp01(y);
      w = Math.max(0, Math.min(w, 1 - x));
      h = Math.max(0, Math.min(h, 1 - y));

      onChange(
        annotationsRef.current.map((item) =>
          item.key === drag.key ? { ...item, x, y, w, h } : item,
        ),
      );
    }
  }

  function onPointerUp() {
    const drag = dragRef.current;
    if (drag.mode === 'draw' && draft) {
      if (draft.w > 0.01 && draft.h > 0.01) {
        onChange([...annotationsRef.current, draft]);
        onSelect(draft.key);
      }
      setDraft(null);
    }
    dragRef.current = { mode: 'none', start: { x: 0, y: 0 }, startPan: { x: 0, y: 0 } };
  }

  function startResize(event: React.PointerEvent, annotation: DraftAnnotation, handle: Handle) {
    event.stopPropagation();
    dragRef.current = {
      mode: 'resize',
      key: annotation.key,
      handle,
      start: stageCoords(event),
      startPan: pan,
      snapshot: { ...annotation },
    };
    wrapperRef.current?.setPointerCapture(event.pointerId);
  }

  function exportPng() {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, imageWidth, imageHeight);
    paint(ctx, img, imageWidth, imageHeight, annotations);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${fileName.replace(/\.[^.]+$/, '')}-已标注.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  const cursor = spaceDown ? 'grab' : readOnly ? 'default' : 'crosshair';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={fitToViewport}>
          适应窗口
        </button>
        <button
          type="button"
          className="btn-ghost px-2.5 py-1 text-xs"
          onClick={() => setZoom(1)}
        >
          100%
        </button>
        <button
          type="button"
          className="btn-ghost px-2.5 py-1 text-xs"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.25))}
        >
          放大
        </button>
        <button
          type="button"
          className="btn-ghost px-2.5 py-1 text-xs"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.25))}
        >
          缩小
        </button>
        <span className="ml-2 text-xs text-ink-500">
          {Math.round(zoom * 100)}% · {imageWidth}×{imageHeight}
        </span>
        <span className="text-xs text-ink-400">滚轮缩放 · 空格或中键拖动平移 · Alt 拖动也可平移</span>
        <button type="button" className="btn-ghost ml-auto px-2.5 py-1 text-xs" onClick={exportPng}>
          导出这张图
        </button>
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-sky/20 bg-ink-950"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(247,251,255,0.14) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      >
        <div
          ref={wrapperRef}
          className="absolute left-0 top-0"
          style={{
            width: base.w,
            height: base.h,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            cursor,
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <canvas ref={canvasRef} className="block" />

          {annotations.map((annotation) => {
            const active = annotation.key === selectedKey && !readOnly;
            const left = annotation.x * base.w;
            const top = annotation.y * base.h;
            const width = annotation.w * base.w;
            const height = annotation.h * base.h;
            const inverse = 1 / zoom;
            return (
              <div
                key={annotation.key}
                className="pointer-events-none absolute"
                style={{ left, top, width, height }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    outline: `1px solid ${active ? '#4da3ff' : 'rgba(255,255,255,0.4)'}`,
                    boxShadow: active ? '0 0 0 1px rgba(0,0,0,0.55)' : undefined,
                  }}
                />
                {active &&
                  HANDLES.map((handle) => {
                    const positions: Record<Handle, { left: number; top: number }> = {
                      nw: { left: 0, top: 0 },
                      n: { left: width / 2, top: 0 },
                      ne: { left: width, top: 0 },
                      e: { left: width, top: height / 2 },
                      se: { left: width, top: height },
                      s: { left: width / 2, top: height },
                      sw: { left: 0, top: height },
                      w: { left: 0, top: height / 2 },
                    };
                    const position = positions[handle];
                    return (
                      <div
                        key={handle}
                        onPointerDown={(event) => startResize(event, annotation, handle)}
                        className="pointer-events-auto absolute rounded-[2px] border border-white bg-brand-400"
                        style={{
                          left: position.left,
                          top: position.top,
                          width: 10 * inverse,
                          height: 10 * inverse,
                          marginLeft: -5 * inverse,
                          marginTop: -5 * inverse,
                          cursor: CURSOR_BY_HANDLE[handle],
                        }}
                      />
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
