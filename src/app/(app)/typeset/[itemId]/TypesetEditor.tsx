'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import { isPin } from '@/lib/annotation';
import type { LpStyle } from '@/lib/labelplus';
import { DEFAULT_LP_STYLES, normalizeStyles, parseGroups, parseStyles } from '@/lib/labelplus';
import { originalUrl } from '@/lib/media';
import { useCollabRoom, type CollabOp } from '@/lib/use-collab-room';
import type { Asset, SpaceAccess, SpaceItem } from '@/lib/types';
import type { TypesetTextLayer } from '@/lib/typeset';

type Tool = 'pan' | 'brush' | 'eraser' | 'eyedropper' | 'rect' | 'lasso' | 'clone' | 'text';

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'pan', label: '平移' },
  { id: 'brush', label: '画笔' },
  { id: 'eraser', label: '橡皮' },
  { id: 'eyedropper', label: '吸管' },
  { id: 'rect', label: '选区填充' },
  { id: 'lasso', label: '套索填充' },
  { id: 'clone', label: '仿制' },
  { id: 'text', label: '文字' },
];

function newLayerId(): string {
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 一次可撤销的完整状态：涂改层位图 + 文字层列表 + 当前选中项 */
type Snapshot = {
  paint: Blob | null;
  layers: TypesetTextLayer[];
  selected: string | null;
};

/** 协作广播的涂改层操作（矢量形式，观众本地重放） */
type PaintOp =
  | {
      type: 'stroke';
      tool: 'brush' | 'eraser';
      color: string;
      size: number;
      opacity: number;
      points: { x: number; y: number }[];
    }
  | {
      type: 'clone';
      size: number;
      opacity: number;
      points: { x: number; y: number }[];
      from: { x: number; y: number };
    }
  | { type: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { type: 'lasso'; points: { x: number; y: number }[]; color: string };

/** 文字连续输入时不要每敲一个字就记一步，停手 700ms 再落一步 */
const HISTORY_COALESCE_MS = 700;
const HISTORY_LIMIT = 50;

export default function TypesetEditor({ itemId }: { itemId: number }) {
  const router = useRouter();
  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<Snapshot[]>([]);
  const histIndex = useRef(-1);
  const baselineKey = useRef('');
  const coalesceTimer = useRef<number | null>(null);
  /** 最近一次「已保存」落在历史的哪一步，用来判断撤销回到该步时是否还算脏 */
  const savedIndex = useRef(0);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const cloneOrigin = useRef<{ x: number; y: number } | null>(null);
  const cloneDelta = useRef<{ x: number; y: number } | null>(null);
  const lassoPts = useRef<{ x: number; y: number }[]>([]);
  /** 文字层拖拽中的状态：id + 起点屏幕坐标 + 该层原始归一化位置 */
  const textDrag = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<SpaceItem | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [spaceName, setSpaceName] = useState('');
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState('#FFFFFF');
  const [size, setSize] = useState(24);
  const [opacity, setOpacity] = useState(100);
  const [textLayers, setTextLayers] = useState<TypesetTextLayer[]>([]);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hasPaint, setHasPaint] = useState(false);
  /** 分组样式预设：按 pin.group_id 套用；空表时落回硬编码默认值 */
  const [styles, setStyles] = useState<Record<string, LpStyle>>({});
  /** LabelPlus 分组表（样式面板按此展示） */
  const [lpGroups, setLpGroups] = useState(parseGroups(null));
  /** 分组样式编辑弹层：开合 + 草稿 */
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleDraft, setStyleDraft] = useState<Record<string, LpStyle>>({});
  const [styleSaving, setStyleSaving] = useState(false);
  /** 前后对比模式：分隔线左侧显示原图，右侧显示当前合成 */
  const [compareMode, setCompareMode] = useState(false);
  /** 分隔线位置（占 wrapper 宽度的百分比 0~100） */
  const [comparePos, setComparePos] = useState(50);
  const compareDragging = useRef(false);

  const imageWidth = asset?.width ?? 1200;
  const imageHeight = asset?.height ?? 800;

  // 协作房间：进页即接管/续期锁，轮询增量操作
  const collab = useCollabRoom(itemId);
  // 权限 = 空间权限 ∧ 房间状态（别人持锁未共享时整页转只读）
  const canEdit = (access?.canEdit ?? false) && (collab.room ? collab.room.canEdit : true);

  // 高频指针事件与防抖回调里要读最新值，不能依赖闭包里的旧 state
  const textLayersRef = useRef(textLayers);
  textLayersRef.current = textLayers;
  const selectedTextRef = useRef(selectedText);
  selectedTextRef.current = selectedText;
  const hasPaintRef = useRef(hasPaint);
  hasPaintRef.current = hasPaint;
  const colorRef = useRef(color);
  colorRef.current = color;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;

  /** 正在进行的笔画，落笔时打包成一条矢量操作广播给房间 */
  const liveStroke = useRef<{
    tool: 'brush' | 'eraser' | 'clone';
    color: string;
    size: number;
    opacity: number;
    points: { x: number; y: number }[];
    from?: { x: number; y: number };
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detailRes, draftRes] = await Promise.all([
        fetch(`/api/items/${itemId}`),
        fetch(`/api/items/${itemId}/typeset`),
      ]);
      if (detailRes.status === 404) {
        router.replace('/spaces');
        return;
      }
      const detail = await detailRes.json();
      const draft = await draftRes.json();
      setItem(detail.item ?? null);
      setAsset(detail.asset ?? null);
      setSpaceName(detail.space?.name ?? '');
      setAccess(detail.access ?? null);
      setTextLayers(draft.meta?.textLayers ?? []);
      setHasPaint(Boolean(draft.hasPaint));
      // 分组表与分组样式：样式缺省时空表，生成时落回硬编码默认值
      setLpGroups(parseGroups(detail.labelplus?.groups));
      setStyles(parseStyles(detail.labelplus?.styles));
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, [itemId, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  const undoRef = useRef<() => Promise<void>>(async () => {});
  const redoRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(true);
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        // 输入框里的 Ctrl+Z 交给浏览器做文本撤销，不要整层回退
        if (typing && !e.shiftKey) return;
        e.preventDefault();
        if (e.shiftKey) void redoRef.current();
        else void undoRef.current();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void redoRef.current();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /** 把「涂改层画布 + 文字层」当前状态压入历史栈 */
  async function pushHistory(layers: TypesetTextLayer[], selected: string | null) {
    const canvas = paintRef.current;
    let paint: Blob | null = null;
    if (canvas) {
      paint = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    const snapshot: Snapshot = { paint, layers, selected };
    historyRef.current = historyRef.current.slice(0, histIndex.current + 1);
    historyRef.current.push(snapshot);
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    histIndex.current = historyRef.current.length - 1;
  }

  /**
   * 建基线：撤销栈的第 0 步永远是「刚加载完草稿」的状态，
   * 这样第一次撤销是回到磁盘上的草稿，而不是把草稿整层擦掉。
   */
  async function establishBaseline() {
    const key = `${itemId}:${hasPaintRef.current}`;
    if (baselineKey.current === key) return;
    baselineKey.current = key;
    historyRef.current = [];
    histIndex.current = -1;
    await pushHistory(textLayersRef.current, null);
    savedIndex.current = histIndex.current;
  }

  /** 连续输入类改动：停手后再记一步 + 广播一次，避免每敲一个字就刷屏 */
  function scheduleHistory(layers: TypesetTextLayer[], selected: string | null) {
    if (coalesceTimer.current !== null) window.clearTimeout(coalesceTimer.current);
    coalesceTimer.current = window.setTimeout(() => {
      coalesceTimer.current = null;
      void pushHistory(layers, selected);
      broadcastText(layers);
    }, HISTORY_COALESCE_MS);
  }

  /** 撤销前先把悬着的输入落袋，否则刚敲的字撤不掉 */
  async function flushCoalesced() {
    if (coalesceTimer.current === null) return;
    window.clearTimeout(coalesceTimer.current);
    coalesceTimer.current = null;
    await pushHistory(textLayersRef.current, selectedTextRef.current);
  }

  function clearCoalesce() {
    if (coalesceTimer.current !== null) {
      window.clearTimeout(coalesceTimer.current);
      coalesceTimer.current = null;
    }
  }

  async function restore(snapshot: Snapshot) {
    const canvas = paintRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (snapshot.paint) {
        const bmp = await createImageBitmap(snapshot.paint);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      }
    }
    setTextLayers(snapshot.layers);
    setSelectedText(snapshot.selected);
    setDirty(histIndex.current !== savedIndex.current);
  }

  async function undo() {
    await flushCoalesced();
    if (histIndex.current <= 0) return;
    histIndex.current -= 1;
    const snapshot = historyRef.current[histIndex.current];
    if (!snapshot) return;
    await restore(snapshot);
  }

  async function redo() {
    await flushCoalesced();
    if (histIndex.current >= historyRef.current.length - 1) return;
    histIndex.current += 1;
    const snapshot = historyRef.current[histIndex.current];
    if (!snapshot) return;
    await restore(snapshot);
  }

  function toLocal(event: { clientX: number; clientY: number }) {
    const wrapper = wrapperRef.current;
    if (!wrapper) return { x: 0, y: 0 };
    const box = wrapper.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * imageWidth,
      y: ((event.clientY - box.top) / box.height) * imageHeight,
    };
  }

  function paintCtx() {
    return paintRef.current?.getContext('2d') ?? null;
  }

  /**
   * 参数化的盖章：本地绘制与「矢量笔画重放」共用这一份逻辑，
   * 保证别人在远端看到的效果和操作者本地完全一致。
   * cloneFrom 存在时是仿制图章：从源位置取像素盖到 (x,y)。
   */
  function stampWith(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    opts: { erase?: boolean; color?: string; size?: number; opacity?: number; cloneFrom?: { x: number; y: number } },
  ) {
    const erase = opts.erase ?? false;
    const r = (opts.size ?? sizeRef.current) / 2;
    const alpha = Math.min(1, Math.max(0.05, (opts.opacity ?? 100) / 100));
    ctx.save();
    ctx.globalAlpha = alpha;
    if (!erase && opts.cloneFrom) {
      const img = wrapperRef.current?.querySelector('img') as HTMLImageElement | null;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.clip();
      if (img) ctx.drawImage(img, opts.cloneFrom.x - x, opts.cloneFrom.y - y);
      ctx.drawImage(ctx.canvas, opts.cloneFrom.x - x, opts.cloneFrom.y - y);
    } else {
      ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
      ctx.fillStyle = opts.color ?? colorRef.current;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, erase: boolean) {
    stampWith(ctx, x, y, { erase, color: colorRef.current, size: sizeRef.current, opacity: opacityRef.current });
  }

  async function sampleColor(x: number, y: number): Promise<string> {
    const img = wrapperRef.current?.querySelector('img');
    const paint = paintRef.current;
    const tmp = document.createElement('canvas');
    tmp.width = 1;
    tmp.height = 1;
    const ctx = tmp.getContext('2d');
    if (!ctx) return color;
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    if (img && (img as HTMLImageElement).complete) {
      ctx.drawImage(img as HTMLImageElement, sx, sy, 1, 1, 0, 0, 1, 1);
    }
    if (paint) ctx.drawImage(paint, sx, sy, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }

  function onPointerDown(event: React.PointerEvent) {
    if (!canEdit) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (event.button === 1 || spaceDown || tool === 'pan') {
      drawing.current = true;
      lastPt.current = { x: event.clientX, y: event.clientY };
      wrapper.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const pt = toLocal(event);
    const ctx = paintCtx();

    if (tool === 'eyedropper') {
      void sampleColor(pt.x, pt.y).then(setColor);
      return;
    }
    if (tool === 'text') {
      const layer: TypesetTextLayer = {
        id: newLayerId(),
        x: pt.x / imageWidth,
        y: pt.y / imageHeight,
        text: '译文',
        fontSize: Math.max(18, imageHeight * 0.035),
        fontWeight: 700,
        color: '#243044',
        stroke: '#FFFFFF',
        strokeWidth: 4,
        align: 'center',
        lineHeight: 1.25,
      };
      const next = [...textLayersRef.current, layer];
      setTextLayers(next);
      setSelectedText(layer.id);
      setDirty(true);
      void pushHistory(next, layer.id);
      broadcastText(next);
      return;
    }
    if (tool === 'clone' && event.altKey) {
      cloneOrigin.current = pt;
      cloneDelta.current = null;
      return;
    }
    if (!ctx) return;
    drawing.current = true;
    lastPt.current = pt;
    wrapper.setPointerCapture(event.pointerId);

    if (tool === 'brush' || tool === 'eraser') {
      stamp(ctx, pt.x, pt.y, tool === 'eraser');
      setDirty(true);
      liveStroke.current = {
        tool,
        color: colorRef.current,
        size: sizeRef.current,
        opacity: opacityRef.current,
        points: [pt],
      };
    }
    if (tool === 'rect') setRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
    if (tool === 'lasso') lassoPts.current = [pt];
    if (tool === 'clone' && cloneOrigin.current) {
      cloneDelta.current = { x: pt.x - cloneOrigin.current.x, y: pt.y - cloneOrigin.current.y };
      liveStroke.current = {
        tool: 'clone',
        color: colorRef.current,
        size: sizeRef.current,
        opacity: opacityRef.current,
        points: [pt],
        from: { ...cloneOrigin.current },
      };
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    // 文字层拖拽：不需要按下画笔那套 drawing 状态，单独走一条通道
    if (textDrag.current) {
      const drag = textDrag.current;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const box = wrapper.getBoundingClientRect();
      const dx = ((event.clientX - drag.startX) / box.width) * imageWidth;
      const dy = ((event.clientY - drag.startY) / box.height) * imageHeight;
      const nx = Math.min(1, Math.max(0, drag.origX + dx / imageWidth));
      const ny = Math.min(1, Math.max(0, drag.origY + dy / imageHeight));
      setTextLayers((prev) =>
        prev.map((l) => (l.id === drag.id ? { ...l, x: nx, y: ny } : l)),
      );
      setDirty(true);
      return;
    }
    if (!drawing.current) return;
    if (spaceDown || tool === 'pan') {
      const last = lastPt.current;
      if (!last) return;
      setPan((p) => ({ x: p.x + event.clientX - last.x, y: p.y + event.clientY - last.y }));
      lastPt.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const pt = toLocal(event);
    const ctx = paintCtx();
    if (!ctx) return;
    if (tool === 'brush' || tool === 'eraser') {
      const prev = lastPt.current;
      if (prev) {
        const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const steps = Math.max(1, Math.floor(dist / (size / 4)));
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          stamp(ctx, prev.x + (pt.x - prev.x) * t, prev.y + (pt.y - prev.y) * t, tool === 'eraser');
        }
      }
      lastPt.current = pt;
      setDirty(true);
      liveStroke.current?.points.push(pt);
    }
    if (tool === 'rect' && lastPt.current) {
      setRect({
        x: Math.min(lastPt.current.x, pt.x),
        y: Math.min(lastPt.current.y, pt.y),
        w: Math.abs(pt.x - lastPt.current.x),
        h: Math.abs(pt.y - lastPt.current.y),
      });
    }
    if (tool === 'lasso') {
      lassoPts.current.push(pt);
      liveStroke.current?.points.push(pt);
    }
    if (tool === 'clone' && cloneDelta.current) {
      const src = { x: pt.x - cloneDelta.current.x, y: pt.y - cloneDelta.current.y };
      stampWith(ctx, pt.x, pt.y, { size: sizeRef.current, opacity: opacityRef.current, cloneFrom: src });
      setDirty(true);
      liveStroke.current?.points.push(pt);
    }
  }

  /** 把一笔操作广播给房间（矢量形式，观众本地重放） */
  function broadcastPaint(op: PaintOp) {
    void collab.sendOp('paint', op);
  }

  /** 文字层快照广播（全量，层数少，几十 KB 以内） */
  const broadcastText = useCallback(
    (layers: TypesetTextLayer[]) => {
      void collab.sendOp('text', { layers });
    },
    [collab],
  );

  /** 重放远端的一笔涂改：和本地画笔共用 stampWith，效果完全一致 */
  function replayPaintOp(op: PaintOp) {
    const ctx = paintCtx();
    if (!ctx) return;
    if (op.type === 'stroke' || op.type === 'clone') {
      const pts = op.points;
      if (pts.length === 0) return;
      const erase = op.type === 'stroke' && op.tool === 'eraser';
      const cloneFrom = op.type === 'clone' ? op.from : undefined;
      stampWith(ctx, pts[0].x, pts[0].y, {
        erase,
        color: op.type === 'stroke' ? op.color : undefined,
        size: op.size,
        opacity: op.opacity,
        cloneFrom,
      });
      for (let i = 1; i < pts.length; i += 1) {
        const prev = pts[i - 1];
        const cur = pts[i];
        const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        const steps = Math.max(1, Math.floor(dist / (op.size / 4)));
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          stampWith(ctx, prev.x + (cur.x - prev.x) * t, prev.y + (cur.y - prev.y) * t, {
            erase,
            color: op.type === 'stroke' ? op.color : undefined,
            size: op.size,
            opacity: op.opacity,
            cloneFrom,
          });
        }
      }
      setDirty(true);
      return;
    }
    if (op.type === 'rect') {
      ctx.fillStyle = op.color;
      ctx.fillRect(op.x, op.y, op.w, op.h);
      setDirty(true);
      return;
    }
    if (op.type === 'lasso' && op.points.length > 2) {
      ctx.fillStyle = op.color;
      ctx.beginPath();
      ctx.moveTo(op.points[0].x, op.points[0].y);
      op.points.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();
      setDirty(true);
    }
  }

  // 远端操作：笔画直接重放，文字层/标注用快照覆盖
  collab.onRemoteOp((op: CollabOp) => {
    if (op.kind === 'paint') {
      replayPaintOp(op.payload as PaintOp);
      return;
    }
    if (op.kind === 'text') {
      const layers = (op.payload as { layers?: TypesetTextLayer[] } | null)?.layers;
      if (Array.isArray(layers)) {
        setTextLayers(layers);
        setDirty(true);
      }
    }
  });

  async function onPointerUp() {
    // 拖完文字层：落一步历史，撤销即可回到拖拽前的位置
    if (textDrag.current) {
      const id = textDrag.current.id;
      textDrag.current = null;
      const next = textLayersRef.current;
      setTextLayers(next);
      setDirty(true);
      await pushHistory(next, id);
      broadcastText(next);
      return;
    }
    if (!drawing.current) return;
    drawing.current = false;
    const ctx = paintCtx();

    // 笔画收尾：把整条矢量轨迹广播出去
    const stroke = liveStroke.current;
    liveStroke.current = null;
    if (stroke && stroke.points.length > 0) {
      if (stroke.tool === 'clone') {
        if (stroke.from) {
          broadcastPaint({
            type: 'clone',
            size: stroke.size,
            opacity: stroke.opacity,
            points: stroke.points,
            from: stroke.from,
          });
        }
      } else {
        broadcastPaint({
          type: 'stroke',
          tool: stroke.tool,
          color: stroke.color,
          size: stroke.size,
          opacity: stroke.opacity,
          points: stroke.points,
        });
      }
    }

    if (tool === 'rect' && rect && ctx && rect.w > 2 && rect.h > 2) {
      ctx.fillStyle = color;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      setDirty(true);
      broadcastPaint({ type: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h, color });
    }
    if (tool === 'lasso' && ctx && lassoPts.current.length > 2) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(lassoPts.current[0].x, lassoPts.current[0].y);
      lassoPts.current.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();
      setDirty(true);
      broadcastPaint({ type: 'lasso', points: [...lassoPts.current], color });
    }
    setRect(null);
    lassoPts.current = [];
    lastPt.current = null;
    if (['brush', 'eraser', 'rect', 'lasso', 'clone'].includes(tool)) {
      await pushHistory(textLayersRef.current, selectedTextRef.current);
    }
  }

  async function save() {
    if (!canEdit || !paintRef.current) return;
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        paintRef.current!.toBlob(resolve, 'image/png'),
      );
      const form = new FormData();
      form.append('meta', JSON.stringify({ textLayers, width: imageWidth, height: imageHeight }));
      if (blob) form.append('paint', blob, 'paint.png');
      const res = await fetch(`/api/items/${itemId}/typeset`, { method: 'PUT', body: form });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? '保存失败');
        return;
      }
      savedIndex.current = histIndex.current;
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = save;
  undoRef.current = undo;
  redoRef.current = redo;

  async function autoInpaint() {
    setError(null);
    const res = await fetch(`/api/items/${itemId}/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: [] }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: '去字失败' }));
      setError(data.error ?? '去字失败');
      return;
    }
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = paintRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    setDirty(true);
    await pushHistory(textLayersRef.current, selectedTextRef.current);
  }

  async function fromPins() {
    const res = await fetch(`/api/items/${itemId}/annotations`);
    const data = await res.json();
    const pins = (data.annotations ?? []).filter(isPin);
    const generated: TypesetTextLayer[] = pins
      .filter((p: { text: string }) => p.text.trim())
      .map((p: { x: number; y: number; text: string; group_id: number }) => {
        // 按分组套用样式预设；未配置时落回默认预置（与样式面板的合并逻辑一致）
        const style = styles[String(p.group_id)] ?? DEFAULT_LP_STYLES[String(p.group_id)];
        return {
          id: newLayerId(),
          x: p.x,
          y: p.y,
          text: p.text,
          fontSize: Math.max(18, imageHeight * (style?.fontSizeRatio ?? 0.032)),
          fontWeight: style?.fontWeight ?? 700,
          color: style?.color ?? (p.group_id === 2 ? '#1F64B8' : '#243044'),
          stroke: style?.stroke ?? '#FFFFFF',
          strokeWidth: style?.strokeWidth ?? 4,
          align: (style?.align ?? 'center') as 'left' | 'center' | 'right',
          lineHeight: style?.lineHeight ?? 1.25,
          vertical: style?.vertical ?? false,
        };
      });
    const next = [...textLayersRef.current, ...generated];
    setTextLayers(next);
    setDirty(true);
    void pushHistory(next, generated[0]?.id ?? selectedTextRef.current);
    broadcastText(next);
  }

  /** 打开分组样式编辑弹层：草稿从当前已保存样式出发，未配置的分组用默认预置兜底 */
  function openStylePanel() {
    const merged: Record<string, LpStyle> = {};
    for (const group of lpGroups) {
      const key = String(group.id);
      merged[key] = styles[key] ?? DEFAULT_LP_STYLES[key] ?? {
        vertical: false,
        color: '#243044',
        stroke: '#FFFFFF',
        strokeWidth: 4,
        fontSizeRatio: 0.032,
        align: 'center',
        fontWeight: 700,
        lineHeight: 1.25,
      };
    }
    setStyleDraft(merged);
    setStyleOpen(true);
  }

  /** 保存分组样式到空间（edit 级权限，与 lp_groups 同级） */
  async function saveStyles() {
    if (!item) return;
    setStyleSaving(true);
    try {
      const cleaned = normalizeStyles(styleDraft);
      const res = await fetch(`/api/spaces/${item.space_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lp_styles: cleaned }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '保存失败' }));
        setError(data.error ?? '保存样式失败');
        return;
      }
      setStyles(cleaned);
      setStyleOpen(false);
    } finally {
      setStyleSaving(false);
    }
  }

  /** 更新弹层里某个分组的某一项样式 */
  function patchDraft(groupId: number, patch: Partial<LpStyle>) {
    setStyleDraft((prev) => ({
      ...prev,
      [String(groupId)]: { ...prev[String(groupId)], ...patch },
    }));
  }

  /** 对比分隔线拖拽：pointer 事件，stopPropagation 避免触发画笔工具 */
  function onCompareHandleDown(event: React.PointerEvent) {
    event.stopPropagation();
    compareDragging.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 不支持捕获时仍可在分隔线上滑动
    }
  }

  function onCompareHandleMove(event: React.PointerEvent) {
    if (!compareDragging.current) return;
    event.stopPropagation();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const box = wrapper.getBoundingClientRect();
    const pct = ((event.clientX - box.left) / box.width) * 100;
    setComparePos(Math.min(100, Math.max(0, pct)));
  }

  function onCompareHandleUp() {
    compareDragging.current = false;
  }

  async function exportPng(writeBack: boolean) {
    const img = wrapperRef.current?.querySelector('img') as HTMLImageElement | null;
    const paint = paintRef.current;
    if (!img || !paint) return;
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, imageWidth, imageHeight);
    ctx.drawImage(paint, 0, 0);
    for (const layer of textLayers) {
      if (layer.visible === false) continue;
      ctx.save();
      ctx.font = `${layer.fontWeight} ${layer.fontSize}px "Noto Sans SC", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = layer.strokeWidth;
      ctx.strokeStyle = layer.stroke;
      ctx.fillStyle = layer.color;
      const originX = layer.x * imageWidth;
      const originY = layer.y * imageHeight;
      const lines = layer.text.split('\n');
      if (layer.vertical) {
        // 竖排：每行文字单独成一列，从右往左排（阅读顺序与日漫一致）
        const columnGap = layer.fontSize * 0.35;
        const totalWidth = (lines.length - 1) * (layer.fontSize + columnGap);
        lines.forEach((line, col) => {
          const colX = originX - totalWidth / 2 + col * (layer.fontSize + columnGap);
          const chars = Array.from(line);
          chars.forEach((ch, i) => {
            const y = originY + (i - (chars.length - 1) / 2) * layer.fontSize * layer.lineHeight;
            if (layer.strokeWidth > 0) ctx.strokeText(ch, colX, y);
            ctx.fillText(ch, colX, y);
          });
        });
      } else {
        ctx.textAlign = layer.align === 'left' ? 'left' : layer.align === 'right' ? 'right' : 'center';
        lines.forEach((line, i) => {
          const y = originY + (i - (lines.length - 1) / 2) * layer.fontSize * layer.lineHeight;
          if (layer.strokeWidth > 0) ctx.strokeText(line, originX, y);
          ctx.fillText(line, originX, y);
        });
      }
      ctx.restore();
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    if (writeBack) {
      const form = new FormData();
      form.append('file', blob, 'typeset.png');
      const res = await fetch(`/api/items/${itemId}/typeset/export`, { method: 'POST', body: form });
      if (!res.ok) {
        setError('写入空间失败');
        return;
      }
      router.push(`/spaces/${item?.space_id}`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${asset?.original_name?.replace(/\.[^.]+$/, '') || 'typeset'}-嵌字.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    const canvas = paintRef.current;
    if (!canvas) return;
    if (!hasPaint) {
      // 没有草稿涂改层：基线就是「空画布 + 已加载的文字层」
      void establishBaseline();
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/items/${itemId}/typeset/paint`);
      if (!res.ok || cancelled) return;
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      if (cancelled) return;
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      ctx?.drawImage(bmp, 0, 0);
      bmp.close();
      // 涂改层画进画布之后再打基线，撤销第 1 步才能回到磁盘上的草稿
      await establishBaseline();
    })();
    return () => {
      cancelled = true;
    };
  }, [hasPaint, itemId, imageWidth, imageHeight]);

  if (loading) return <p className="py-20 text-center text-sm text-ink-500">加载中…</p>;
  if (!item || !asset) {
    return (
      <div className="card py-20 text-center">
        <EmptyState padded={false} kaomoji="(・・?)" title={error ?? '图片不存在'} />
      </div>
    );
  }

  const selected = textLayers.find((l) => l.id === selectedText);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/annotate/${itemId}`} className="text-sm text-ink-400 hover:text-sky-deep">
          ← {spaceName || '标号'} / {item.title || '未命名'}
        </Link>
        <span className="rounded bg-sky/15 px-2 py-0.5 text-xs text-sky-deep">嵌字</span>
        {collab.room?.holderName && !collab.room.isHolder && !collab.room.shared && (
          <span className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-700">
            🔒 {collab.room.holderName} 正在编辑
          </span>
        )}
        {collab.room?.shared && (
          <span className="rounded bg-emerald-500/15 px-2 py-1 text-xs text-emerald-700">
            🟢 实时协作中
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {collab.room?.isHolder && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => void collab.setShared(!collab.room?.shared)}
            >
              {collab.room?.shared ? '结束共享' : '共享编辑'}
            </button>
          )}
          <button type="button" className="btn-ghost text-xs" onClick={() => void fromPins()}>
            从标号生成文字层
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={openStylePanel}>
            分组样式
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void autoInpaint()}>
            自动去字
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void undo()}>
            撤销
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void redo()}>
            重做
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void exportPng(false)}>
            导出 PNG
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void exportPng(true)}>
            写入空间
          </button>
          <button type="button" className="btn-primary text-xs" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? '保存中…' : '保存草稿'}
          </button>
        </span>
      </div>
      {error && <p className="notice-error">{error}</p>}

      {styleOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4" onClick={() => setStyleOpen(false)}>
          <div
            className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-xl border border-ink-700 bg-cloud p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-ink-100">分组样式预设</h2>
              <button type="button" className="text-xs text-ink-400 hover:text-ink-100" onClick={() => setStyleOpen(false)}>
                ✕
              </button>
            </div>
            <p className="mt-1 text-[11px] text-ink-500">「从标号生成文字层」时按分组套用这里的样式。</p>
            <div className="mt-3 space-y-3">
              {lpGroups.map((group) => {
                const draft = styleDraft[String(group.id)];
                if (!draft) return null;
                return (
                  <div key={group.id} className="rounded-lg border border-ink-700 bg-paper p-2">
                    <div className="flex items-center gap-2 text-xs text-ink-200">
                      <span className="rounded bg-sky/15 px-2 py-0.5 font-medium text-sky-deep">组 {group.id}</span>
                      <span className="truncate">{group.name}</span>
                      <label className="ml-auto flex items-center gap-1 text-[11px] text-ink-500">
                        <input
                          type="checkbox"
                          checked={draft.vertical}
                          onChange={(e) => patchDraft(group.id, { vertical: e.target.checked })}
                        />
                        竖排
                      </label>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-ink-500 sm:grid-cols-4">
                      <label>
                        文字颜色
                        <input
                          type="color"
                          value={draft.color}
                          onChange={(e) => patchDraft(group.id, { color: e.target.value })}
                          className="mt-1 h-7 w-full"
                        />
                      </label>
                      <label>
                        描边色
                        <input
                          type="color"
                          value={draft.stroke}
                          onChange={(e) => patchDraft(group.id, { stroke: e.target.value })}
                          className="mt-1 h-7 w-full"
                        />
                      </label>
                      <label>
                        描边宽 {draft.strokeWidth}px
                        <input
                          type="number"
                          min={0}
                          max={40}
                          step={1}
                          value={draft.strokeWidth}
                          onChange={(e) => patchDraft(group.id, { strokeWidth: Number(e.target.value) || 0 })}
                          className="input mt-1 h-7 text-xs"
                        />
                      </label>
                      <label>
                        字号比例
                        <input
                          type="number"
                          min={0.005}
                          max={0.2}
                          step={0.002}
                          value={draft.fontSizeRatio}
                          onChange={(e) => patchDraft(group.id, { fontSizeRatio: Number(e.target.value) || 0.032 })}
                          className="input mt-1 h-7 text-xs"
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn-ghost text-xs" onClick={() => setStyleOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary text-xs" disabled={styleSaving} onClick={() => void saveStyles()}>
                {styleSaving ? '保存中…' : '保存样式'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex w-40 shrink-0 flex-col gap-2 rounded-xl border border-ink-700 bg-cloud/80 p-2">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`seg-btn text-left ${tool === entry.id ? 'seg-btn-on' : ''}`}
              onClick={() => setTool(entry.id)}
            >
              {entry.label}
            </button>
          ))}
          <label className="mt-2 text-[11px] text-ink-500">
            颜色
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="mt-1 h-8 w-full" />
          </label>
          <label className="text-[11px] text-ink-500">
            大小 {size}px
            <input
              type="range"
              min={2}
              max={120}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="mt-1 w-full accent-sky"
            />
          </label>
          <label className="text-[11px] text-ink-500">
            不透明度 {opacity}%
            <input
              type="range"
              min={5}
              max={100}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="mt-1 w-full accent-sky"
            />
          </label>
          <p className="text-[11px] text-ink-400">原图层已锁定。橡皮只擦涂改层。仿制：Alt 取源后涂抹（同源对齐）。</p>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-2 flex gap-2 text-xs">
            <button type="button" className="btn-ghost px-2 py-1" onClick={() => setZoom(1)}>
              100%
            </button>
            <button type="button" className="btn-ghost px-2 py-1" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}>
              放大
            </button>
            <button type="button" className="btn-ghost px-2 py-1" onClick={() => setZoom((z) => Math.max(0.15, z / 1.25))}>
              缩小
            </button>
            <button
              type="button"
              className={`btn-ghost px-2 py-1 ${compareMode ? 'btn-primary' : ''}`}
              onClick={() => {
                setCompareMode((v) => !v);
                setComparePos(50);
              }}
            >
              对比
            </button>
            <span className="text-ink-500">{Math.round(zoom * 100)}% · {imageWidth}×{imageHeight}</span>
          </div>
          <div
            ref={viewportRef}
            className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-sky/20 bg-ink-950"
          >
            <div
              ref={wrapperRef}
              className="absolute left-0 top-0"
              style={{
                width: imageWidth,
                height: imageHeight,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                cursor: spaceDown || tool === 'pan' ? 'grab' : tool === 'text' ? 'text' : 'crosshair',
                touchAction: 'none',
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => void onPointerUp()}
              onPointerCancel={() => void onPointerUp()}
            >
              <img
                src={originalUrl(asset.filename)}
                alt=""
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none"
              />
              <canvas
                ref={paintRef}
                width={imageWidth}
                height={imageHeight}
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
              {textLayers.map((layer) => (
                <div
                  key={layer.id}
                  className={`absolute max-w-[40%] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap ${
                    layer.vertical ? 'text-start' : 'text-center'
                  } ${selectedText === layer.id ? 'outline outline-2 outline-halo' : ''}`}
                  style={{
                    left: `${layer.x * 100}%`,
                    top: `${layer.y * 100}%`,
                    color: layer.color,
                    fontSize: layer.fontSize,
                    fontWeight: layer.fontWeight,
                    WebkitTextStroke: `${layer.strokeWidth / 2}px ${layer.stroke}`,
                    lineHeight: layer.lineHeight,
                    writingMode: layer.vertical ? 'vertical-rl' : 'horizontal-tb',
                    display: layer.visible === false ? 'none' : undefined,
                    pointerEvents: tool === 'text' ? 'auto' : 'none',
                    cursor: tool === 'text' ? 'move' : undefined,
                  }}
                  onPointerDown={(event) => {
                    if (tool !== 'text') return;
                    event.stopPropagation();
                    setSelectedText(layer.id);
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      // 浏览器不支持时退化为窗口级监听，拖拽仍然可用
                    }
                    textDrag.current = {
                      id: layer.id,
                      startX: event.clientX,
                      startY: event.clientY,
                      origX: layer.x,
                      origY: layer.y,
                    };
                  }}
                >
                  {layer.text}
                </div>
              ))}
              {rect && (
                <div
                  className="pointer-events-none absolute border border-halo bg-halo/20"
                  style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                />
              )}
              {compareMode && (
                <>
                  {/* 对比覆盖层：分隔线左侧盖一层原图，右侧露出下面的当前合成（涂改+文字层） */}
                  <img
                    src={originalUrl(asset.filename)}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute inset-0 h-full w-full select-none"
                    style={{ clipPath: `inset(0 ${100 - comparePos}% 0 0)` }}
                  />
                  <div
                    className="absolute inset-y-0 z-10 flex w-4 -translate-x-1/2 cursor-col-resize items-center justify-center"
                    style={{ left: `${comparePos}%`, touchAction: 'none' }}
                    onPointerDown={onCompareHandleDown}
                    onPointerMove={onCompareHandleMove}
                    onPointerUp={onCompareHandleUp}
                    onPointerCancel={onCompareHandleUp}
                  >
                    <div className="h-full w-0.5 bg-halo" />
                    <div className="absolute flex h-7 w-7 items-center justify-center rounded-full bg-cloud/90 text-[10px] text-ink-300 shadow">
                      ⇔
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <aside className="w-64 shrink-0 rounded-xl border border-ink-700 bg-cloud/80 p-3">
          <h2 className="text-sm font-medium text-ink-100">图层</h2>
          <ul className="mt-2 space-y-1 text-xs text-ink-300">
            <li className="rounded bg-paper px-2 py-1">背景（原图，锁定）</li>
            <li className="rounded bg-paper px-2 py-1">涂改 {dirty ? '· 未保存' : ''}</li>
          </ul>
          <div className="mt-2">
            <div className="flex items-center justify-between text-[11px] text-ink-500">
              <span>文字层 · {textLayers.length}</span>
            </div>
            <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
              {textLayers.length === 0 && (
                <li className="rounded bg-paper px-2 py-1 text-[11px] text-ink-500">暂无文字层</li>
              )}
              {[...textLayers].reverse().map((layer) => (
                <li
                  key={layer.id}
                  className={`flex items-center gap-1 rounded px-1 py-0.5 ${
                    selectedText === layer.id ? 'bg-sky/15' : 'bg-paper'
                  }`}
                >
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-ink-400 hover:text-ink-100"
                    title={layer.visible === false ? '显示' : '隐藏'}
                    onClick={() => {
                      const next = textLayersRef.current.map((l) =>
                        l.id === layer.id ? { ...l, visible: layer.visible === false } : l,
                      );
                      setTextLayers(next);
                      setDirty(true);
                      void pushHistory(next, selectedTextRef.current);
                      broadcastText(next);
                    }}
                  >
                    {layer.visible === false ? '🚫' : '👁'}
                  </button>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[11px] text-ink-200 hover:text-ink-100"
                    onClick={() => {
                      setTool('text');
                      setSelectedText(layer.id);
                    }}
                    title="选中该层（切换到文字工具可拖动）"
                  >
                    {layer.text.split('\n')[0] || '（空）'}
                  </button>
                  <span className="shrink-0 text-[10px] text-ink-500">{layer.vertical ? '竖' : '横'}</span>
                </li>
              ))}
            </ul>
          </div>
          {selected && (
            <div className="mt-3 space-y-2">
              <textarea
                className="input min-h-[80px] text-xs"
                value={selected.text}
                onChange={(e) => {
                  const next = textLayersRef.current.map((l) =>
                    l.id === selected.id ? { ...l, text: e.target.value } : l,
                  );
                  setTextLayers(next);
                  setDirty(true);
                  scheduleHistory(next, selected.id);
                }}
              />
              <label className="text-[11px] text-ink-500">
                字号
                <input
                  type="range"
                  min={10}
                  max={120}
                  value={selected.fontSize}
                  onChange={(e) => {
                    const fontSize = Number(e.target.value);
                    const next = textLayersRef.current.map((l) =>
                      l.id === selected.id ? { ...l, fontSize } : l,
                    );
                    setTextLayers(next);
                    setDirty(true);
                    scheduleHistory(next, selected.id);
                  }}
                  className="w-full accent-sky"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`btn-ghost py-1 text-xs ${selected.vertical ? 'btn-primary' : ''}`}
                  onClick={() => {
                    const next = textLayersRef.current.map((l) =>
                      l.id === selected.id ? { ...l, vertical: !selected.vertical } : l,
                    );
                    setTextLayers(next);
                    setDirty(true);
                    void pushHistory(next, selected.id);
                    broadcastText(next);
                  }}
                >
                  {selected.vertical ? '竖排' : '横排'}
                </button>
                <button
                  type="button"
                  className="btn-ghost py-1 text-xs"
                  onClick={() => {
                    const idx = textLayersRef.current.findIndex((l) => l.id === selected.id);
                    const swapWith = idx > 0 ? idx - 1 : idx + 1;
                    if (swapWith < 0 || swapWith >= textLayersRef.current.length || swapWith === idx) return;
                    const next = [...textLayersRef.current];
                    const [moved] = next.splice(idx, 1);
                    next.splice(swapWith, 0, moved);
                    setTextLayers(next);
                    setDirty(true);
                    void pushHistory(next, selected.id);
                    broadcastText(next);
                  }}
                >
                  上移一层
                </button>
              </div>
              <button
                type="button"
                className="btn-danger w-full py-1 text-xs"
                onClick={() => {
                  clearCoalesce();
                  const next = textLayersRef.current.filter((l) => l.id !== selected.id);
                  setTextLayers(next);
                  setSelectedText(null);
                  setDirty(true);
                  void pushHistory(next, null);
                  broadcastText(next);
                }}
              >
                删除文字层
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
