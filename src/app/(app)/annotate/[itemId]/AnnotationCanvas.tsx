'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CANVAS_FONT,
  clamp01,
  hasRunOverrides,
  isPin,
  layoutRunLines,
  layoutText,
  newKey,
  styledCharsOf,
  type DraftAnnotation,
} from '@/lib/annotation';
import { groupColor } from '@/lib/labelplus';

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
    if (isPin(annotation)) continue;
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

    const innerWidth = Math.max(8, w - padding * 2);
    const innerHeight = Math.max(8, h - padding * 2);
    // 文字不透明度（底色透明度由 bg_color 表达，互不影响）
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, annotation.text_opacity ?? 1));
    ctx.textBaseline = 'top';

    if (hasRunOverrides(annotation.runs)) {
      // 富文本路径：按 runs 逐段排版绘制，保证导出与预览一致
      const chars = styledCharsOf(annotation, height);
      const lines = layoutRunLines(
        ctx,
        chars,
        innerWidth,
        innerHeight,
        Math.max(4, annotation.font_size_ratio * height * 1.25),
      );
      const blockHeight = lines.reduce((sum, line) => sum + line.height, 0);
      let cursorY = y + (h - blockHeight) / 2;
      for (const line of lines) {
        let cursorX = x + padding;
        if (annotation.align === 'center') cursorX = x + (w - line.width) / 2;
        else if (annotation.align === 'right') cursorX = x + w - padding - line.width;
        for (const char of line.chars) {
          ctx.font = CANVAS_FONT.replace('700', String(char.weight)).replace('{size}', String(char.size));
          ctx.fillStyle = char.color;
          ctx.fillText(char.ch, cursorX, cursorY + (line.height - char.size * 1.25) / 2);
          cursorX += char.width;
        }
        cursorY += line.height;
      }
    } else {
      const { lines, fontSize, lineHeight } = layoutText(
        ctx,
        text,
        innerWidth,
        annotation.font_weight,
        annotation.font_size_ratio * height,
        innerHeight,
      );

      ctx.fillStyle = annotation.color;
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
    ctx.restore();
  }
}

export type EditorMode = 'box' | 'browse' | 'label' | 'input' | 'review';

export default function AnnotationCanvas({
  imageSrc,
  previewSrc,
  imageWidth,
  imageHeight,
  annotations,
  selectedKey,
  selectedKeys,
  onSelect,
  onMultiSelect,
  onChange,
  fileName,
  readOnly,
  mode = 'box',
  hidePins = false,
  showGroupNames = false,
  defaultGroupId = 1,
  followSelection = false,
  onRemoveKeys,
  onToggleDoubtfulKeys,
}: {
  imageSrc: string;
  previewSrc?: string;
  imageWidth: number;
  imageHeight: number;
  annotations: DraftAnnotation[];
  selectedKey: string | null;
  /** 多选集合（含 selectedKey），用于高亮与橡皮筋加选 */
  selectedKeys?: string[];
  onSelect: (key: string | null) => void;
  /** Ctrl+橡皮筋松开时回调；additive = 加选（Ctrl+Shift） */
  onMultiSelect?: (keys: string[], additive: boolean) => void;
  onChange: (next: DraftAnnotation[]) => void;
  fileName: string;
  readOnly: boolean;
  mode?: EditorMode;
  hidePins?: boolean;
  showGroupNames?: boolean;
  defaultGroupId?: number;
  followSelection?: boolean;
  /** 右键菜单「删除」回调（keys 为生效选中集，编辑器统一走确认弹窗） */
  onRemoveKeys?: (keys: string[]) => void;
  /** 右键菜单「存疑切换」回调（多选时批量） */
  onToggleDoubtfulKeys?: (keys: string[]) => void;
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
  // Ctrl+橡皮筋选框（stage 坐标，松开时把相交标注并入选中集）
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  // 右键上下文菜单：视口内坐标 + 生效选中集（右键命中已选中的标注时作用于整个多选集）
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; keys: string[] } | null>(
    null,
  );

  const dragRef = useRef<{
    mode: 'none' | 'pan' | 'draw' | 'move' | 'resize' | 'marquee';
    key?: string;
    handle?: Handle;
    start: { x: number; y: number };
    startPan: { x: number; y: number };
    snapshot?: DraftAnnotation;
    /**橡皮筋是否加选（Ctrl+Shift） */
    additive?: boolean;
  }>({ mode: 'none', start: { x: 0, y: 0 }, startPan: { x: 0, y: 0 } });

  // 标注数据的最新引用，供高频指针事件读取而不重复绑定回调
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const hidePinsRef = useRef(hidePins);
  hidePinsRef.current = hidePins;
  const defaultGroupRef = useRef(defaultGroupId);
  defaultGroupRef.current = defaultGroupId;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;

  const originalImgRef = useRef<HTMLImageElement | null>(null);

  // 生效中的选中集：多选集合缺省时退化为 selectedKey 单选
  const selection = selectedKeys ?? (selectedKey ? [selectedKey] : []);

  useEffect(() => {
    let cancelled = false;
    originalImgRef.current = null;

    function load(src: string, isOriginal: boolean) {
      const element = new Image();
      element.onload = () => {
        if (cancelled) return;
        if (isOriginal) originalImgRef.current = element;
        setImg(element);
      };
      element.src = src;
    }

    if (previewSrc) load(previewSrc, false);
    load(imageSrc, true);
    return () => {
      cancelled = true;
    };
  }, [imageSrc, previewSrc]);

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

  useEffect(() => {
    if (!followSelection || !selectedKey || !base.w) return;
    const pin = annotations.find((a) => a.key === selectedKey && isPin(a));
    if (!pin || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    setPan({
      x: rect.width / 2 - pin.x * base.w * zoom,
      y: rect.height / 2 - pin.y * base.h * zoom,
    });
  }, [followSelection, selectedKey]);

  // 右键菜单打开时：点击外部 / Esc / 滚轮（缩放）关闭。
  // 菜单项用 onPointerDown 触发动作（早于 window 的 click 收尾），不会被误吞。
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('wheel', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  /** 画布右键：命中标注 → 弹上下文菜单；空白处 → 不弹任何菜单（连浏览器默认也不弹） */
  function onContextMenu(event: React.MouseEvent) {
    // 右键菜单是编辑功能：只读模式不弹（也不弹浏览器默认菜单）
    if (readOnly) {
      event.preventDefault();
      return;
    }
    if (!base.w) return;
    const hit = hitTest(stageCoords(event));
    if (!hit) {
      event.preventDefault();
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    // 命中的标注已在多选集合里 → 菜单作用于整个选中集；否则先单选它
    const inSelection = selection.length > 1 && selection.includes(hit.key);
    const keys = inSelection ? selection : [hit.key];
    if (!selection.includes(hit.key)) onSelect(hit.key);
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 简单防溢出：贴近视口右/下边缘时往回收（菜单约 150×90）
    setContextMenu({
      x: Math.min(event.clientX - rect.left, rect.width - 160),
      y: Math.min(event.clientY - rect.top, rect.height - 96),
      keys,
    });
  }

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

  function hitTestPin(point: { x: number; y: number }): DraftAnnotation | null {
    if (hidePinsRef.current) return null;
    const nx = point.x / base.w;
    const ny = point.y / base.h;
    const rx = 18 / base.w;
    const ry = 18 / base.h;
    let best: DraftAnnotation | null = null;
    let bestDist = Infinity;
    for (const annotation of annotationsRef.current) {
      if (!isPin(annotation)) continue;
      const dx = nx - annotation.x;
      const dy = ny - annotation.y;
      if (Math.abs(dx) <= rx && Math.abs(dy) <= ry) {
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          best = annotation;
          bestDist = dist;
        }
      }
    }
    return best;
  }

  function hitTestBox(point: { x: number; y: number }): DraftAnnotation | null {
    const nx = point.x / base.w;
    const ny = point.y / base.h;
    for (let i = annotationsRef.current.length - 1; i >= 0; i -= 1) {
      const annotation = annotationsRef.current[i];
      if (isPin(annotation)) continue;
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

  function hitTest(point: { x: number; y: number }): DraftAnnotation | null {
    if (modeRef.current === 'box') return hitTestBox(point);
    return hitTestPin(point) ?? (modeRef.current === 'browse' ? hitTestBox(point) : null);
  }

  /** 标注与橡皮筋选框是否相交：pin 按中心点落入，box 按矩形重叠 */
  function intersectsMarquee(
    annotation: DraftAnnotation,
    rect: { x: number; y: number; w: number; h: number },
  ): boolean {
    if (isPin(annotation)) {
      return (
        annotation.x >= rect.x &&
        annotation.x <= rect.x + rect.w &&
        annotation.y >= rect.y &&
        annotation.y <= rect.y + rect.h
      );
    }
    return (
      annotation.x < rect.x + rect.w &&
      annotation.x + annotation.w > rect.x &&
      annotation.y < rect.y + rect.h &&
      annotation.y + annotation.h > rect.y
    );
  }

  /**
   * 图片外（深色背景区）按下 → 直接进入平移，任何模式一致；
   * 落点在图片内则不处理，交给 wrapper 的原有逻辑（画框/选标号/移动等）。
   * 拖动进入图片区域后凭 pointer capture 持续平移，直到松开。
   */
  function onViewportPointerDown(event: React.PointerEvent) {
    if (!base.w || event.button !== 0) return;
    const wrapper = wrapperRef.current;
    const viewport = viewportRef.current;
    if (!wrapper || !viewport) return;
    const rect = wrapper.getBoundingClientRect();
    const nx = (event.clientX - rect.left) / (rect.width || 1);
    const ny = (event.clientY - rect.top) / (rect.height || 1);
    if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) return; // 图片内：原逻辑接管
    dragRef.current = {
      mode: 'pan',
      start: { x: event.clientX, y: event.clientY },
      startPan: pan,
    };
    viewport.setPointerCapture(event.pointerId);
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

    // Ctrl+拖拽：橡皮筋多选（Ctrl+Shift 为加选），不与创建框 / 放标号的拖拽冲突
    if (event.ctrlKey) {
      const startPoint = stageCoords(event);
      dragRef.current = {
        mode: 'marquee',
        additive: event.shiftKey,
        start: startPoint,
        startPan: pan,
      };
      setMarquee({ x0: startPoint.x, y0: startPoint.y, x1: startPoint.x, y1: startPoint.y });
      wrapper.setPointerCapture(event.pointerId);
      return;
    }

    const point = stageCoords(event);
    const currentMode = modeRef.current;
    const hit = hitTest(point);

    if (currentMode === 'label' && !hit) {
      const nx = clamp01(point.x / base.w);
      const ny = clamp01(point.y / base.h);
      const pin: DraftAnnotation = {
        key: newKey(),
        x: nx,
        y: ny,
        w: 0,
        h: 0,
        text: '',
        font_size_ratio: 0.035,
        color: '#FFFFFF',
        bg_color: '#000000B3',
        align: 'left',
        font_weight: 700,
        kind: 'pin',
        group_id: defaultGroupRef.current,
        source_text: '',
        comment: '',
      };
      onChange([...annotationsRef.current, pin]);
      onSelect(pin.key);
      dragRef.current = {
        mode: 'move',
        key: pin.key,
        start: point,
        startPan: pan,
        snapshot: { ...pin },
      };
      wrapper.setPointerCapture(event.pointerId);
      return;
    }

    if (hit) {
      onSelect(hit.key);
      if (currentMode === 'browse' || currentMode === 'input' || currentMode === 'review') {
        if (isPin(hit) && currentMode !== 'input' && currentMode !== 'review') {
          dragRef.current = {
            mode: 'move',
            key: hit.key,
            start: point,
            startPan: pan,
            snapshot: { ...hit },
          };
          wrapper.setPointerCapture(event.pointerId);
        }
        return;
      }
      dragRef.current = {
        mode: 'move',
        key: hit.key,
        start: point,
        startPan: pan,
        snapshot: { ...hit },
      };
    } else if (currentMode === 'box') {
      onSelect(null);
      dragRef.current = {
        mode: 'draw',
        start: point,
        startPan: pan,
      };
    } else {
      onSelect(null);
      return;
    }
    wrapper.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (drag.mode === 'none' && modeRef.current === 'review' && base.w) {
      const hover = hitTestPin(stageCoords(event));
      if (hover && hover.key !== selectedKeyRef.current) onSelect(hover.key);
    }

    if (drag.mode === 'none' || !base.w) return;

    if (drag.mode === 'pan') {
      setPan({
        x: drag.startPan.x + (event.clientX - drag.start.x),
        y: drag.startPan.y + (event.clientY - drag.start.y),
      });
      return;
    }

    if (drag.mode === 'marquee') {
      const current = stageCoords(event);
      setMarquee((m) => (m ? { ...m, x1: current.x, y1: current.y } : m));
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
        kind: 'box',
        group_id: 1,
        source_text: '',
        comment: '',
      });
      return;
    }

    if (drag.mode === 'move' && drag.snapshot) {
      const dx = (point.x - drag.start.x) / base.w;
      const dy = (point.y - drag.start.y) / base.h;
      const snap = drag.snapshot;
      const x = isPin(snap)
        ? clamp01(snap.x + dx)
        : clamp01(Math.min(snap.x + dx, 1 - snap.w));
      const y = isPin(snap)
        ? clamp01(snap.y + dy)
        : clamp01(Math.min(snap.y + dy, 1 - snap.h));
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

  function onPointerUp(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (drag.mode === 'marquee') {
      const p = stageCoords(event);
      const nx0 = clamp01(Math.min(drag.start.x, p.x) / base.w);
      const ny0 = clamp01(Math.min(drag.start.y, p.y) / base.h);
      const nx1 = clamp01(Math.max(drag.start.x, p.x) / base.w);
      const ny1 = clamp01(Math.max(drag.start.y, p.y) / base.h);
      const rect = { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
      let hits: string[];
      if (rect.w < 0.005 && rect.h < 0.005) {
        // 几乎没拖动 = Ctrl+单击：退化为点选（pin 优先，框选次之）
        const hit = hitTestPin(p) ?? hitTestBox(p);
        hits = hit ? [hit.key] : [];
      } else {
        hits = annotationsRef.current.filter((a) => intersectsMarquee(a, rect)).map((a) => a.key);
      }
      onMultiSelect?.(hits, drag.additive ?? false);
      setMarquee(null);
    }
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
    const source = originalImgRef.current ?? img;
    if (!source) return;
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, imageWidth, imageHeight);
    paint(ctx, source, imageWidth, imageHeight, annotations);
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

  const cursor = spaceDown
    ? 'grab'
    : readOnly
      ? 'default'
      : mode === 'box'
        ? 'crosshair'
        : mode === 'label'
          ? 'cell'
          : 'default';

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
        <span className="text-xs text-ink-400">滚轮缩放 · 空格/中键/Alt 拖动平移 · 图片外拖动也可平移</span>
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
        onPointerDown={onViewportPointerDown}
        // wrapper 内的拖拽事件会冒泡到这里统一处理，避免双份触发
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* 右键上下文菜单：删除（走确认弹窗）/ 存疑切换，多选时作用于整个选中集 */}
        {contextMenu && (
          <div
            className="absolute z-30 min-w-[9.5rem] rounded-lg border border-ink-700 bg-cloud py-1 shadow-card"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-xs text-blush hover:bg-blush/10"
              onPointerDown={() => {
                onRemoveKeys?.(contextMenu.keys);
                setContextMenu(null);
              }}
            >
              {contextMenu.keys.length > 1
                ? `删除 (${contextMenu.keys.length})`
                : '删除'}
            </button>
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left text-xs text-ink-200 hover:bg-sky/15"
              onPointerDown={() => {
                onToggleDoubtfulKeys?.(contextMenu.keys);
                setContextMenu(null);
              }}
            >
              {contextMenu.keys.length > 1
                ? '批量切换存疑'
                : annotationsRef.current.find((a) => a.key === contextMenu.keys[0])?.doubtful
                  ? '取消存疑'
                  : '存疑'}
            </button>
          </div>
        )}
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
          onContextMenu={onContextMenu}
        >
          <canvas ref={canvasRef} className="block" />

          {annotations.map((annotation) => {
            if (isPin(annotation)) {
              if (hidePins) return null;
              const pinIndex = annotations.filter((a) => isPin(a)).indexOf(annotation) + 1;
              const color = groupColor(annotation.group_id || 1);
              const active = selection.includes(annotation.key);
              const size = 22 / zoom;
              return (
                <div
                  key={annotation.key}
                  className="pointer-events-none absolute flex flex-col items-center"
                  style={{
                    left: annotation.x * base.w,
                    top: annotation.y * base.h,
                    transform: 'translate(-50%, -50%)',
                  }}
                >
                  <div
                    className="flex items-center justify-center rounded-full font-bold text-white shadow"
                    style={{
                      width: size,
                      height: size,
                      fontSize: Math.max(10, 12 / zoom),
                      background: color,
                      // 选中 = 黄色描边；存疑 = amber 描边
                      outline: active
                        ? '2px solid #E8C547'
                        : annotation.doubtful
                          ? '2px solid #F59E0B'
                          : '2px solid rgba(255,255,255,0.85)',
                    }}
                  >
                    {pinIndex}
                  </div>
                  {showGroupNames && (
                    <span
                      className="mt-0.5 whitespace-nowrap rounded px-1 text-[10px] text-white"
                      style={{ background: color, fontSize: Math.max(9, 10 / zoom) }}
                    >
                      {annotation.group_id}
                    </span>
                  )}
                  {mode === 'review' && active && (annotation.source_text || annotation.text) && (
                    <span
                      className="pointer-events-none absolute bottom-full mb-1 max-w-[260px] whitespace-pre-wrap rounded-md bg-ink-950/95 px-2 py-1 text-left text-ink-100 shadow-lg ring-1 ring-white/15"
                      style={{ fontSize: Math.max(10, 12 / zoom) }}
                    >
                      {annotation.source_text && (
                        <span className="block text-ink-400">{annotation.source_text}</span>
                      )}
                      {annotation.text && <span className="block">{annotation.text}</span>}
                    </span>
                  )}
                </div>
              );
            }

            const active = annotation.key === selectedKey && !readOnly && mode === 'box';
            // 多选中的框也高亮（但不显示缩放手柄，手柄只跟随主选中项）
            const inSelection = selection.includes(annotation.key);
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
                    outline: `1px solid ${
                      active || inSelection ? '#4da3ff' : 'rgba(255,255,255,0.4)'
                    }`,
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

          {/* Ctrl+橡皮筋选框：半透明 sky 色矩形 */}
          {marquee && (
            <div
              className="pointer-events-none absolute"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
                background: 'rgba(77,163,255,0.18)',
                outline: '1px solid #4da3ff',
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
