'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import { isPin } from '@/lib/annotation';
import type { LpStyle } from '@/lib/labelplus';
import { DEFAULT_LP_STYLES, normalizeStyles, parseGroups, parseStyles } from '@/lib/labelplus';
import { originalUrl } from '@/lib/media';
import {
  DEFAULT_ADJUST,
  applyLutToImageData,
  computeAdjustLut,
  isDefaultAdjust,
  lutToTableValues,
  normalizeAdjust,
  type TypesetAdjust,
} from '@/lib/typeset-adjust';
import { useCollabRoom, type CollabOp } from '@/lib/use-collab-room';
import type { Asset, SpaceAccess, SpaceItem } from '@/lib/types';
import { writePsd, type Layer as PsdLayer, type Psd } from 'ag-psd';
import { buildPsdTextLayer } from '@/lib/psd-text';
import {
  groupVerticalRuns,
  hasHalfWidthChars,
  normalizeTextLayers,
  wrapTextWithWidth,
  type TypesetTextLayer,
  type VerticalRun,
} from '@/lib/typeset-layer';

type Tool = 'pan' | 'brush' | 'eraser' | 'eyedropper' | 'rect' | 'lasso' | 'clone' | 'text' | 'liquify';

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'pan', label: '平移' },
  { id: 'brush', label: '画笔' },
  { id: 'eraser', label: '橡皮' },
  { id: 'eyedropper', label: '吸管' },
  { id: 'rect', label: '矩形选区' },
  { id: 'lasso', label: '套索选区' },
  { id: 'clone', label: '图章' },
  { id: 'liquify', label: '液化' },
  { id: 'text', label: '文字' },
];

/**
 * 持久选区：rect/lasso 工具拖出的形状（松手后保留在画布上，虚线框预览），
 * 供「填充选区」（旧行为：松手即填充）与「选区去字」（光栅化成蒙版）消费，Esc 清除。
 */
type Selection =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'lasso'; points: { x: number; y: number }[] };

/** 颜色串追加透明度（仅支持 #RRGGBB 形态，软边径向渐变用；其余形态回退不透明） */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return alpha >= 1 ? hex : 'transparent';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 常用系统字体预设（CSS font-family 栈，DOM 预览与 canvas 导出共用同一份值） */
const SYSTEM_FONT_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '微软雅黑', value: '"Microsoft YaHei", "微软雅黑"' },
  { label: '思源黑体', value: '"Source Han Sans SC", "Noto Sans CJK SC"' },
  { label: '宋体', value: 'SimSun, "宋体"' },
  { label: '黑体', value: 'SimHei, "黑体"' },
  { label: '楷体', value: 'KaiTi, "楷体"' },
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
      soft?: boolean;
      points: { x: number; y: number }[];
    }
  | {
      type: 'clone';
      size: number;
      opacity: number;
      soft?: boolean;
      points: { x: number; y: number }[];
      from: { x: number; y: number };
    }
  | { type: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { type: 'lasso'; points: { x: number; y: number }[]; color: string }
  | {
      type: 'liquify';
      /** 笔画首尾点（规格字段，直线重放兜底用）；points 存在时远端按完整路径重放 */
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      radius: number;
      strength: number;
      points?: { x: number; y: number }[];
    };

/** 文字连续输入时不要每敲一个字就记一步，停手 700ms 再落一步 */
const HISTORY_COALESCE_MS = 700;

/**
 * 撤销栈深度按图片长边动态收缩：每步快照都是整幅涂改层 PNG Blob，
 * 大图深栈会占数百 MB 内存（4000×6000 图单步 PNG 可达数十 MB）。
 * 长边 ≤2000px 维持 100 步；2000~4000px 50 步；>4000px 30 步。
 *
 * 「大图涂改层降采样编辑 + 导出全分辨率重放」评估结论：不做。
 * 原因：草稿存储是 meta.json（矢量文字层）+ paint.png（涂改层位图），
 * 并没有矢量 strokes 持久化（协作 PaintOp 只广播不落盘）——
 * 重放方案必须先引入 strokes 存储格式与兼容迁移，或接受编辑期位图缩放的精度损失
 * （与「涂改层即所见」语义冲突），改造风险大于收益，按「不硬做」决策仅保留动态栈深。
 */
function historyLimitFor(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  if (longEdge <= 2000) return 100;
  if (longEdge <= 4000) return 50;
  return 30;
}

/** 背景调整滑条配置（与 typeset-adjust.ts 的参数范围一一对应） */
const ADJUST_SLIDERS: Array<{
  key: keyof TypesetAdjust;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'brightness', label: '亮度', min: 0.5, max: 1.5, step: 0.01 },
  { key: 'contrast', label: '对比度', min: 0.5, max: 1.5, step: 0.01 },
  { key: 'blackPoint', label: '黑场', min: 0, max: 0.3, step: 0.005 },
  { key: 'whitePoint', label: '白场', min: 0.7, max: 1, step: 0.005 },
  { key: 'gamma', label: 'Gamma', min: 0.5, max: 2, step: 0.01 },
];

/** 文字层 8 向变换手柄（角/上下 = 等比缩放，左右 = 限宽；竖排层隐藏左右） */
const TEXT_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type TextHandle = (typeof TEXT_HANDLES)[number];

const CURSOR_BY_TEXT_HANDLE: Record<TextHandle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

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
  /** 变换手柄拖拽中：等比缩放（角/上下）/ 限宽（左右）/ 旋转，全部绕层包围盒中心 */
  const handleDrag = useRef<{
    id: string;
    kind: 'scale' | 'width' | 'rotate';
    startLocal: { x: number; y: number };
    centerLocal: { x: number; y: number };
    startDist: number;
    startScale: number;
    startWidthPx: number;
    startAngle: number;
    startRotation: number;
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
  /** 多选集合：Shift+点击追加；主选中（属性面板绑定对象）= selectedText */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** 软边笔刷：径向渐变透明度（对画笔/橡皮生效；图章因 clip 采样保持硬边） */
  const [softBrush, setSoftBrush] = useState(false);
  /** 参考线开关（仅预览辅助，不进层数据、不导出；localStorage 记忆） */
  const [showGuides, setShowGuides] = useState(false);
  /** 删除文字层前的二次确认 */
  const [confirmDeleteLayer, setConfirmDeleteLayer] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hasPaint, setHasPaint] = useState(false);
  /** 当前持久选区（矩形/套索松手后落在这里，Esc 或消费动作清除） */
  const [selShape, setSelShape] = useState<Selection | null>(null);
  /** 背景调整（非破坏，仅存草稿 meta + 导出时应用 LUT；全默认零像素差异） */
  const [adjust, setAdjust] = useState<TypesetAdjust>(DEFAULT_ADJUST);
  /** 双击就地编辑：进行中的层 id 与文本草稿（null = 未在编辑） */
  const [editingText, setEditingText] = useState<{ id: string; value: string } | null>(null);
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
  // 保存成品：进行中 / 成功提示（「已保存，本图共 n 个成品版本」）
  const [savingOutput, setSavingOutput] = useState(false);
  const [outputNotice, setOutputNotice] = useState<string | null>(null);
  // 自定义字体：已上传列表 + 上传进行中标记
  const [fontList, setFontList] = useState<string[]>([]);
  const [fontUploading, setFontUploading] = useState(false);
  const fontInputRef = useRef<HTMLInputElement>(null);
  /** 已注册到 document.fonts 的字体名（幂等加载） */
  const loadedFonts = useRef<Set<string>>(new Set());
  /** 离屏测量 canvas（横排限宽断行用，复用单个上下文） */
  const measureCtx = useRef<CanvasRenderingContext2D | null>(null);

  const imageWidth = asset?.width ?? 1200;
  const imageHeight = asset?.height ?? 800;

  /** 用户是否手动动过视图（缩放/平移）：动过之后窗口 resize 不再自动重置视图 */
  const userAdjusted = useRef(false);

  /** 适应窗口：按视口缩放并居中（Stage 3 修复「打开后图片居左上角」） */
  const fitToViewport = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    if (vw <= 0 || vh <= 0) return;
    const padding = 24;
    const scale = Math.min((vw - padding) / imageWidth, (vh - padding) / imageHeight);
    const z = Math.min(8, Math.max(0.05, scale));
    setZoom(z);
    setPan({ x: (vw - imageWidth * z) / 2, y: (vh - imageHeight * z) / 2 });
  }, [imageWidth, imageHeight]);

  // 首次进入自动适应：图片已缓存时 onLoad 不触发，这里兜底再试一次
  useEffect(() => {
    if (!asset) return;
    const img = wrapperRef.current?.querySelector('img');
    if (img?.complete) fitToViewport();
  }, [asset, fitToViewport]);

  // 窗口尺寸变化保持适应（用户手动调整过视图则不打扰）
  useEffect(() => {
    const onResize = () => {
      if (!userAdjusted.current) fitToViewport();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitToViewport]);

  // 协作房间：进页即接管/续期锁，轮询增量操作
  const collab = useCollabRoom(itemId);
  // 权限 = 空间权限 ∧ 房间状态（别人持锁未共享时整页转只读）
  const canEdit = (access?.canEdit ?? false) && (collab.room ? collab.room.canEdit : true);

  // 高频指针事件与防抖回调里要读最新值，不能依赖闭包里的旧 state
  const textLayersRef = useRef(textLayers);
  textLayersRef.current = textLayers;
  const selectedTextRef = useRef(selectedText);
  selectedTextRef.current = selectedText;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const hasPaintRef = useRef(hasPaint);
  hasPaintRef.current = hasPaint;
  const colorRef = useRef(color);
  colorRef.current = color;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  const softBrushRef = useRef(softBrush);
  softBrushRef.current = softBrush;
  const adjustRef = useRef(adjust);
  adjustRef.current = adjust;

  /** 正在进行的笔画，落笔时打包成一条矢量操作广播给房间 */
  const liveStroke = useRef<{
    tool: 'brush' | 'eraser' | 'clone';
    color: string;
    size: number;
    opacity: number;
    soft?: boolean;
    points: { x: number; y: number }[];
    from?: { x: number; y: number };
  } | null>(null);

  /**
   * 进行中的一笔液化：source 是「背景(带 LUT) + 涂改层」的合成快照画布，
   * 作为向前变形的采样源并随每步同步形变，保证连续拖动累积（PS 向前变形同款）。
   */
  const liquify = useRef<{
    source: HTMLCanvasElement;
    points: { x: number; y: number }[];
    radius: number;
    strength: number;
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
      setTextLayers(normalizeTextLayers(draft.meta?.textLayers ?? []));
      setAdjust(normalizeAdjust(draft.meta?.adjust));
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

  // 进入嵌字页：拉取自定义字体列表并逐个注册到 document.fonts（失败字体静默跳过，不影响编辑）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/fonts');
        if (!res.ok) return;
        const data = (await res.json()) as { fonts?: unknown };
        if (cancelled) return;
        const names = Array.isArray(data.fonts) ? (data.fonts as string[]) : [];
        setFontList(names);
        names.forEach((name) => void loadCustomFont(name));
      } catch {
        // 字体列表拉取失败不影响编辑
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 参考线开关记忆（仅预览辅助，零持久化到层数据）
  useEffect(() => {
    if (localStorage.getItem('typeset-guides') === '1') setShowGuides(true);
  }, []);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  const undoRef = useRef<() => Promise<void>>(async () => {});
  const redoRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(true);
      // Esc 取消持久选区（不影响其它快捷键，选区不是可撤销状态）
      if (e.key === 'Escape') setSelShape(null);
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
      // 工具快捷键与删除（输入态不抢键）
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key.toLowerCase() === 's') setTool('clone');
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedIdsRef.current.length > 0) {
            e.preventDefault();
            setConfirmDeleteLayer(true);
          }
        }
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
    // 栈深按图片尺寸动态收缩（while 防御：极端情况下一次裁掉多步）
    while (historyRef.current.length > historyLimitFor(imageWidth, imageHeight)) {
      historyRef.current.shift();
    }
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
    setSelection(snapshot.selected ? [snapshot.selected] : []);
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
    opts: {
      erase?: boolean;
      color?: string;
      size?: number;
      opacity?: number;
      soft?: boolean;
      cloneFrom?: { x: number; y: number };
    },
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
      const col = opts.color ?? colorRef.current;
      // 重放协作笔画时以 op 自带 soft 为准（缺省硬边），
      // 不回落本端软边开关——否则旧对端的硬边笔画会被本端重放成软边
      if (opts.soft ?? false) {
        // 软边：径向渐变透明度（50% 半径内全强度，向边缘渐隐）；橡皮用 destination-out 同理渐隐
        const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r);
        g.addColorStop(0, withAlpha(col, 1));
        g.addColorStop(1, withAlpha(col, 0));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = col;
      }
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

  // ---- 液化（向前变形）：自研环形位移重采样，不引入新依赖 ----

  /** 液化采样源：背景（带 LUT，与预览所见一致）+ 涂改层的合成快照。img 未就绪时返回 null */
  function buildLiquifySource(): HTMLCanvasElement | null {
    const img = wrapperRef.current?.querySelector('img') as HTMLImageElement | null;
    const paint = paintRef.current;
    if (!img || !paint || !img.complete) return null;
    const src = document.createElement('canvas');
    src.width = imageWidth;
    src.height = imageHeight;
    const sctx = src.getContext('2d');
    if (!sctx) return null;
    sctx.drawImage(img, 0, 0, imageWidth, imageHeight);
    applyBackgroundAdjust(sctx, imageWidth, imageHeight);
    sctx.drawImage(paint, 0, 0);
    return src;
  }

  /**
   * 单步向前变形：以 to 为中心、radius 为影响域，把 source 的内容沿位移方向
   * 「环形位移重采样」画进 target——从外到内画 LIQUIFY_RINGS 个同心环带，
   * 环带位移比例从边缘 0 线性衰减到中心 1（阶梯近似径向软边，环带内层覆盖外层）。
   * 非破坏：原图数据不动，形变结果落在涂改层（等同「高级图章」）。
   */
  const LIQUIFY_RINGS = 8;
  function liquifyStep(
    target: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    from: { x: number; y: number },
    to: { x: number; y: number },
    radius: number,
    strength: number,
  ) {
    const dx = (to.x - from.x) * strength;
    const dy = (to.y - from.y) * strength;
    const r = radius / 2;
    if (r < 2 || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) return;
    for (let i = LIQUIFY_RINGS; i >= 1; i -= 1) {
      const outer = (i / LIQUIFY_RINGS) * r;
      const inner = ((i - 1) / LIQUIFY_RINGS) * r;
      // 环带位移比例 = 径向衰减（环带中点：边缘≈0、中心≈1）
      const f = 1 - (i - 0.5) / LIQUIFY_RINGS;
      target.save();
      target.beginPath();
      target.arc(to.x, to.y, outer, 0, Math.PI * 2);
      if (inner > 0) target.arc(to.x, to.y, inner, 0, Math.PI * 2, true); // 反向绕行 = 环形 clip
      target.clip();
      target.drawImage(source, dx * f, dy * f);
      target.restore();
    }
  }

  /**
   * 沿 from→to 按固定步长（radius/4）插值应用液化，本地拖动与远端重放共用这同一份逻辑，
   * 保证两端逐位一致。每步把形变同步写回合成源（自引用 drawImage 规范要求先快照，
   * 各浏览器均如此实现），后续步采样到累积形变——连续拖动才能推出平滑形变。
   */
  function applyLiquifyAlong(
    target: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    from: { x: number; y: number },
    to: { x: number; y: number },
    radius: number,
    strength: number,
  ) {
    const sourceCtx = source.getContext('2d');
    if (!sourceCtx) return;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.round(dist / Math.max(1, radius / 4)));
    let prev = from;
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const cur = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      liquifyStep(target, source, prev, cur, radius, strength);
      liquifyStep(sourceCtx, source, prev, cur, radius, strength);
      prev = cur;
    }
  }

  /** 远端液化重放：重建合成源后沿完整路径（缺省退化为起终点直线）重放同一套步进逻辑 */
  function replayLiquifyOp(op: Extract<PaintOp, { type: 'liquify' }>) {
    const ctx = paintCtx();
    if (!ctx) return;
    const source = buildLiquifySource();
    if (!source) return;
    const pts =
      op.points && op.points.length >= 2
        ? op.points
        : [
            { x: op.x0, y: op.y0 },
            { x: op.x1, y: op.y1 },
          ];
    for (let i = 1; i < pts.length; i += 1) {
      applyLiquifyAlong(ctx, source, pts[i - 1], pts[i], op.radius, op.strength);
    }
    setDirty(true);
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
      setSelection([layer.id]);
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
        soft: softBrushRef.current,
        points: [pt],
      };
    }
    if (tool === 'liquify') {
      const source = buildLiquifySource();
      if (!source) {
        // 背景图未就绪：本次按下不生效（不进入拖动状态）
        drawing.current = false;
        return;
      }
      // 笔刷大小 = 影响域直径，不透明度滑条 = 液化强度（与笔刷控件复用）
      liquify.current = { source, points: [pt], radius: sizeRef.current, strength: opacityRef.current / 100 };
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
        soft: softBrushRef.current,
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
    // 变换手柄拖拽：缩放/限宽/旋转实时预览
    if (handleDrag.current) {
      moveHandleDrag(event);
      return;
    }
    if (!drawing.current) return;
    if (spaceDown || tool === 'pan') {
      const last = lastPt.current;
      if (!last) return;
      userAdjusted.current = true;
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
    if (tool === 'liquify' && liquify.current) {
      const liq = liquify.current;
      const prev = lastPt.current;
      if (prev) {
        // 实时全分辨率应用（环形位移重采样本身够快，无需降采样预览）
        applyLiquifyAlong(ctx, liq.source, prev, pt, liq.radius, liq.strength);
        liq.points.push(pt);
        setDirty(true);
      }
      lastPt.current = pt;
    }
  }

  /** 把一笔操作广播给房间（矢量形式，观众本地重放） */
  function broadcastPaint(op: PaintOp) {
    void collab.sendOp('paint', op);
  }

  /** 文字层快照广播（全量，层数少，几十 KB 以内）；顺带带上调到最新的背景调整，保证观众端预览一致 */
  const broadcastText = useCallback(
    (layers: TypesetTextLayer[]) => {
      void collab.sendOp('text', { layers, adjust: adjustRef.current });
    },
    [collab],
  );

  /** 背景调整广播防抖：滑条连续拖动只在停手后发一次（adjust 不进撤销栈） */
  const adjustBroadcastTimer = useRef<number | null>(null);
  function scheduleAdjustBroadcast() {
    if (adjustBroadcastTimer.current !== null) window.clearTimeout(adjustBroadcastTimer.current);
    adjustBroadcastTimer.current = window.setTimeout(() => {
      adjustBroadcastTimer.current = null;
      void collab.sendOp('text', { layers: textLayersRef.current, adjust: adjustRef.current });
    }, 500);
  }

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
        soft: op.soft,
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
            soft: op.soft,
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
      return;
    }
    if (op.type === 'liquify') {
      replayLiquifyOp(op);
    }
  }

  // 远端操作：笔画直接重放，文字层/标注用快照覆盖
  collab.onRemoteOp((op: CollabOp) => {
    if (op.kind === 'paint') {
      replayPaintOp(op.payload as PaintOp);
      return;
    }
    if (op.kind === 'text') {
      const payload = op.payload as { layers?: unknown; adjust?: unknown } | null;
      if (Array.isArray(payload?.layers)) {
        setTextLayers(normalizeTextLayers(payload!.layers));
        setDirty(true);
      }
      // 远端背景调整：normalizeAdjust 防御清洗（旧对端不带 adjust 字段则不动本端）
      if (payload?.adjust !== undefined) setAdjust(normalizeAdjust(payload.adjust));
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
    // 变换手柄松手：落一步历史 + 广播（拖拽中只做了本地预览）
    if (handleDrag.current) {
      const drag = handleDrag.current;
      handleDrag.current = null;
      const next = textLayersRef.current;
      setTextLayers(next);
      setDirty(true);
      await pushHistory(next, drag.id);
      broadcastText(next);
      return;
    }
    if (!drawing.current) return;
    drawing.current = false;

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
            soft: stroke.soft,
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
          soft: stroke.soft,
          points: stroke.points,
        });
      }
    }

    // 液化收尾：广播完整路径（带规格要求的起终点字段；points 供观众端按曲线重放）
    const liq = liquify.current;
    liquify.current = null;
    if (liq && liq.points.length >= 2) {
      const first = liq.points[0];
      const last = liq.points[liq.points.length - 1];
      broadcastPaint({
        type: 'liquify',
        x0: first.x,
        y0: first.y,
        x1: last.x,
        y1: last.y,
        radius: liq.radius,
        strength: liq.strength,
        points: liq.points,
      });
    }

    // 矩形/套索：松手不再直接填充（旧行为），改为落成持久选区，
    // 由「填充选区」（旧行为等价按钮）或「选区去字」（蒙版去字）消费
    if (tool === 'rect' && rect && rect.w > 2 && rect.h > 2) {
      setSelShape({ kind: 'rect', x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    }
    if (tool === 'lasso' && lassoPts.current.length > 2) {
      setSelShape({ kind: 'lasso', points: [...lassoPts.current] });
    }
    setRect(null);
    lassoPts.current = [];
    lastPt.current = null;
    // 选区本身不进撤销栈（不是像素/图层状态）；填充动作在自己的入口里落历史
    if (['brush', 'eraser', 'clone', 'liquify'].includes(tool)) {
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
      form.append(
        'meta',
        JSON.stringify({ textLayers, adjust, width: imageWidth, height: imageHeight }),
      );
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

  /** 调去字 API 并把结果画进涂改层：maskDataUrl 存在时按蒙版去字，否则回退标号框（旧行为） */
  async function requestInpaint(maskDataUrl?: string) {
    setError(null);
    const res = await fetch(`/api/items/${itemId}/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maskDataUrl ? { mask: maskDataUrl } : { boxes: [] }),
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

  /** 涂改层是否有笔迹（任一像素 alpha>0）。只在点击去字时扫一次，不在绘制热路径上 */
  function paintHasStrokes(): boolean {
    const canvas = paintRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }
    return false;
  }

  /**
   * 把画布转成去字蒙版 dataURL：涂改层是「笔迹画在透明底上」的语义，
   * 服务端按 alpha>阈值 判定去字区域，所以直接整幅拷贝即可（笔迹颜色无所谓）。
   */
  function canvasToMaskDataUrl(src: HTMLCanvasElement): string {
    const mask = document.createElement('canvas');
    mask.width = imageWidth;
    mask.height = imageHeight;
    mask.getContext('2d')?.drawImage(src, 0, 0, mask.width, mask.height);
    return mask.toDataURL('image/png');
  }

  /** 把选区光栅化成蒙版画布：选区内白色（去字）、外透明（保留） */
  function selectionToMaskCanvas(shape: Selection): HTMLCanvasElement | null {
    const mask = document.createElement('canvas');
    mask.width = imageWidth;
    mask.height = imageHeight;
    const mctx = mask.getContext('2d');
    if (!mctx) return null;
    mctx.fillStyle = '#FFFFFF';
    if (shape.kind === 'rect') {
      mctx.fillRect(shape.x, shape.y, shape.w, shape.h);
    } else if (shape.points.length > 2) {
      mctx.beginPath();
      mctx.moveTo(shape.points[0].x, shape.points[0].y);
      shape.points.forEach((p) => mctx.lineTo(p.x, p.y));
      mctx.closePath();
      mctx.fill();
    }
    return mask;
  }

  /** 自动去字：涂改层有笔迹时用笔迹当蒙版（笔迹=去字区域），否则回退标号固定框 */
  async function autoInpaint() {
    if (!canEdit) return;
    const canvas = paintRef.current;
    const maskDataUrl = canvas && paintHasStrokes() ? canvasToMaskDataUrl(canvas) : undefined;
    await requestInpaint(maskDataUrl);
  }

  /** 选区去字：把当前选区光栅化成蒙版发请求，成功后清除选区 */
  async function inpaintSelection() {
    if (!canEdit || !selShape) return;
    const maskCanvas = selectionToMaskCanvas(selShape);
    if (!maskCanvas) return;
    setSelShape(null);
    await requestInpaint(maskCanvas.toDataURL('image/png'));
  }

  /** 填充选区：rect/lasso 松手即填的旧行为改为按钮触发（选区可先用于去字或填充二选一） */
  async function fillSelection() {
    if (!canEdit || !selShape) return;
    const ctx = paintCtx();
    if (!ctx) return;
    if (selShape.kind === 'rect') {
      ctx.fillStyle = color;
      ctx.fillRect(selShape.x, selShape.y, selShape.w, selShape.h);
      broadcastPaint({ type: 'rect', x: selShape.x, y: selShape.y, w: selShape.w, h: selShape.h, color });
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(selShape.points[0].x, selShape.points[0].y);
      selShape.points.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();
      broadcastPaint({ type: 'lasso', points: selShape.points, color });
    }
    setDirty(true);
    setSelShape(null);
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

  /** 注册单个自定义字体到 document.fonts；重复调用幂等，失败静默跳过 */
  async function loadCustomFont(name: string) {
    if (loadedFonts.current.has(name)) return;
    loadedFonts.current.add(name); // 先占位，避免并发重复加载同一字体
    try {
      const res = await fetch(`/api/fonts/${encodeURIComponent(name)}`);
      if (!res.ok) {
        loadedFonts.current.delete(name);
        return;
      }
      const buf = await res.arrayBuffer();
      const face = new FontFace(name, buf);
      await face.load();
      document.fonts.add(face);
    } catch {
      loadedFonts.current.delete(name);
    }
  }

  /** 上传自定义字体：成功后注册进 document.fonts 并自动选中到当前文字层 */
  async function uploadFont(file: File) {
    setFontUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/fonts', { method: 'POST', body: form });
      const data = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? '字体上传失败');
        return;
      }
      const name = data.name ?? '';
      if (!name) return;
      setFontList((prev) => (prev.includes(name) ? prev : [...prev, name]));
      await loadCustomFont(name);
      if (selectedTextRef.current) {
        // 存带引号的字体名，DOM / canvas 的 font-family 直接可用
        patchLayer(selectedTextRef.current, { fontFamily: JSON.stringify(name) });
      }
    } catch {
      setError('字体上传失败');
    } finally {
      setFontUploading(false);
    }
  }

  /** 层的 canvas 字体表达式（DOM 预览与导出共用同一份，保证两端字体一致） */
  function layerFontExpr(layer: TypesetTextLayer): string {
    const family = layer.fontFamily
      ? `${layer.fontFamily}, "Noto Sans SC", sans-serif`
      : '"Noto Sans SC", sans-serif';
    return `${layer.fontWeight} ${layer.fontSize}px ${family}`;
  }

  /** 离屏逐字符测量（横排限宽断行用）；SSR 或 ctx 不可用时返回 null */
  function measureFor(layer: TypesetTextLayer): ((ch: string) => number) | null {
    if (typeof document === 'undefined') return null;
    if (!measureCtx.current) {
      measureCtx.current = document.createElement('canvas').getContext('2d');
    }
    const ctx = measureCtx.current;
    if (!ctx) return null;
    ctx.font = layerFontExpr(layer);
    return (ch: string) => ctx.measureText(ch).width;
  }

  /**
   * 横排限宽/字距布局（DOM 预览与 renderPngBlob 共用）：
   * 返回逐行逐字符宽度；null = 走旧渲染路径（不限宽且无字距，老数据零变化）。
   */
  function layoutHorizontal(layer: TypesetTextLayer): Array<Array<{ ch: string; w: number }>> | null {
    if (layer.width == null && !layer.letterSpacing) return null;
    const m = measureFor(layer) ?? ((ch: string) => ch.length * layer.fontSize);
    const spacingPx = (layer.letterSpacing ?? 0) * layer.fontSize;
    const maxWidth = (layer.width ?? 1) * imageWidth;
    return wrapTextWithWidth(layer.text, m, maxWidth, spacingPx).map((line) =>
      Array.from(line).map((ch) => ({ ch, w: m(ch) })),
    );
  }

  /** 设置选中集合：selectedIds 为全集，selectedText 恒为主选中（最后一个），兼容单选链路 */
  function setSelection(ids: string[]) {
    setSelectedIds(ids);
    setSelectedText(ids.length > 0 ? ids[ids.length - 1] : null);
  }

  /** 选中文字层：additive = Shift 追加/移除；否则裸选单层 */
  function selectLayer(id: string, additive: boolean) {
    const cur = selectedIdsRef.current;
    const next = additive
      ? cur.includes(id)
        ? cur.filter((x) => x !== id)
        : [...cur, id]
      : [id];
    setSelection(next);
  }

  /**
   * 更新选中文字层的通用入口（字号/颜色/特效等属性面板共用）：
   * coalesce=true 用于滑杆等连续输入（停手后落一步历史 + 广播一次），
   * 否则立即落历史 + 广播（与「竖排/上移一层」同一模式）。
   * 多选时（id 属于选中集合且 ≥2 层）改动批量应用到全部选中层。
   */
  function patchLayer(id: string, patch: Partial<TypesetTextLayer>, coalesce = false) {
    const ids =
      selectedIdsRef.current.length > 1 && selectedIdsRef.current.includes(id)
        ? selectedIdsRef.current
        : [id];
    const next = textLayersRef.current.map((l) => (ids.includes(l.id) ? { ...l, ...patch } : l));
    setTextLayers(next);
    setDirty(true);
    if (coalesce) scheduleHistory(next, id);
    else {
      void pushHistory(next, id);
      broadcastText(next);
    }
  }

  /** 文字层包围盒（画布 px）：锚点口径与渲染/导出一致（横排左/右对齐时 x 是边缘锚点，其余 x/y 是块中心锚点） */
  function layerBBox(layer: TypesetTextLayer): { left: number; top: number; w: number; h: number } {
    const fs = layer.fontSize;
    const lines = layer.text.split('\n');
    let w = 0;
    let h = 0;
    if (layer.vertical) {
      // 竖排：块宽 = 列组宽度；块高 = 最高列的字格总高（与渲染同一套公式）
      const gap = fs * 0.35;
      w = (lines.length - 1) * (fs + gap) + fs;
      const spacingPx = (layer.letterSpacing ?? 0) * fs;
      const useTcy = layer.tcyEnabled !== false;
      const cellH = fs * layer.lineHeight + spacingPx;
      const tcyCells = (runText: string) =>
        Math.max(2, Math.ceil((runText.length * 0.5 * fs) / Math.max(1, fs * layer.lineHeight)));
      const runH = (line: string) => {
        const runs =
          spacingPx !== 0 || (useTcy && hasHalfWidthChars(line))
            ? groupVerticalRuns(line)
            : Array.from(line).map((ch) => ({ kind: 'char' as const, text: ch }));
        return runs.reduce(
          (sum, run) => sum + (run.kind === 'char' || run.small ? cellH : tcyCells(run.text) * cellH),
          0,
        );
      };
      h = Math.max(0, ...lines.map(runH));
    } else {
      const spacingPx = (layer.letterSpacing ?? 0) * fs;
      const layout = layoutHorizontal(layer);
      if (layout) {
        w = Math.max(
          0,
          ...layout.map((cells) => cells.reduce((s, c) => s + c.w, 0) + spacingPx * Math.max(0, cells.length - 1)),
        );
      } else {
        const m = measureFor(layer) ?? ((ch: string) => ch.length * fs);
        w = Math.max(0, ...lines.map((line) => Array.from(line).reduce((s, ch) => s + m(ch), 0)));
      }
      h = lines.length * fs * layer.lineHeight;
    }
    const left =
      !layer.vertical && layer.align === 'left'
        ? layer.x * imageWidth
        : !layer.vertical && layer.align === 'right'
          ? layer.x * imageWidth - w
          : layer.x * imageWidth - w / 2;
    return { left, top: layer.y * imageHeight - h / 2, w, h };
  }

  /** 批量对齐选中文字层（≥2 层生效）：按选中层包围盒的极值/中心改 x/y（锚点语义不变，只平移） */
  function alignLayers(mode: 'left' | 'centerH' | 'right' | 'top' | 'centerV') {
    const ids = selectedIdsRef.current;
    if (ids.length < 2) return;
    const boxes = new Map<string, ReturnType<typeof layerBBox>>();
    for (const id of ids) {
      const l = textLayersRef.current.find((x) => x.id === id);
      if (l) boxes.set(id, layerBBox(l));
    }
    if (boxes.size < 2) return;
    const list = [...boxes.values()];
    const minLeft = Math.min(...list.map((b) => b.left));
    const maxRight = Math.max(...list.map((b) => b.left + b.w));
    const minTop = Math.min(...list.map((b) => b.top));
    const maxBottom = Math.max(...list.map((b) => b.top + b.h));
    const groupCx = (minLeft + maxRight) / 2;
    const groupCy = (minTop + maxBottom) / 2;
    const next = textLayersRef.current.map((l) => {
      const b = boxes.get(l.id);
      if (!b) return l;
      let dx = 0;
      let dy = 0;
      if (mode === 'left') dx = minLeft - b.left;
      else if (mode === 'centerH') dx = groupCx - (b.left + b.w / 2);
      else if (mode === 'right') dx = maxRight - (b.left + b.w);
      else if (mode === 'top') dy = minTop - b.top;
      else dy = groupCy - (b.top + b.h / 2);
      return { ...l, x: l.x + dx / imageWidth, y: l.y + dy / imageHeight };
    });
    setTextLayers(next);
    setDirty(true);
    void pushHistory(next, selectedTextRef.current);
    broadcastText(next);
  }

  /**
   * 开始拖拽变换手柄（仅文字工具 + 可编辑时渲染）：
   * 角/上下手柄 = 等比缩放（拖拽点到中心距离比例驱动，不改 fontSize），左右手柄 = 限宽，
   * 旋转手柄 = 绕包围盒中心旋转。拖拽中实时 setTextLayers 预览，松手在 onPointerUp 落历史 + 广播。
   * 距离/角度全部用画布坐标系计算（wrapper 均匀缩放，比值与屏幕系等价）。
   */
  function startHandleDrag(
    event: React.PointerEvent,
    layer: TypesetTextLayer,
    kind: 'scale' | 'width' | 'rotate',
  ) {
    if (!canEdit) return;
    event.stopPropagation();
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      wrapper.setPointerCapture(event.pointerId);
    } catch {
      // 浏览器不支持捕获时仍可在窗口内拖拽
    }
    const bbox = layerBBox(layer);
    const centerLocal = { x: bbox.left + bbox.w / 2, y: bbox.top + bbox.h / 2 };
    const startLocal = toLocal(event);
    handleDrag.current = {
      id: layer.id,
      kind,
      startLocal,
      centerLocal,
      startDist: Math.max(1, Math.hypot(startLocal.x - centerLocal.x, startLocal.y - centerLocal.y)),
      startScale: layer.scale ?? 1,
      startWidthPx: Math.max(imageWidth * 0.05, bbox.w * (layer.scale ?? 1)),
      startAngle: (Math.atan2(startLocal.y - centerLocal.y, startLocal.x - centerLocal.x) * 180) / Math.PI,
      startRotation: layer.rotation ?? 0,
    };
  }

  /** 拖拽手柄时更新对应字段（实时预览，不入历史） */
  function moveHandleDrag(event: React.PointerEvent) {
    const drag = handleDrag.current;
    if (!drag) return;
    const p = toLocal(event);
    if (drag.kind === 'scale') {
      // 等比缩放：拖拽距离 / 初始距离 的比例乘到 scale（非破坏，不改 fontSize）
      const dist = Math.hypot(p.x - drag.centerLocal.x, p.y - drag.centerLocal.y);
      const scale = Math.min(4, Math.max(0.2, drag.startScale * (dist / drag.startDist)));
      setTextLayers((prev) => prev.map((l) => (l.id === drag.id ? { ...l, scale } : l)));
    } else if (drag.kind === 'width') {
      // 限宽：绕中心向两侧扩展（视觉宽 = 初始 + 2×拖拽量），clamp 到 5%~100% 画布宽
      const wPx = Math.max(imageWidth * 0.05, drag.startWidthPx + 2 * (p.x - drag.startLocal.x));
      const width = Math.min(1, Math.max(0.05, wPx / imageWidth));
      setTextLayers((prev) => prev.map((l) => (l.id === drag.id ? { ...l, width } : l)));
    } else {
      // 旋转：指点绕中心的角度增量加到初始角度，规范到 [-180, 180)
      const angle = (Math.atan2(p.y - drag.centerLocal.y, p.x - drag.centerLocal.x) * 180) / Math.PI;
      const rotation = ((drag.startRotation + angle - drag.startAngle + 180) % 360 + 360) % 360 - 180;
      setTextLayers((prev) => prev.map((l) => (l.id === drag.id ? { ...l, rotation } : l)));
    }
    setDirty(true);
  }

  /** 双击文字层：就地编辑（画布上浮起 textarea，水平定位近似包围盒，不随旋转） */
  function openTextEdit(layer: TypesetTextLayer) {
    return (event: React.MouseEvent) => {
      if (!canEdit) return;
      event.stopPropagation();
      setEditingText({ id: layer.id, value: layer.text });
    };
  }

  /** 提交就地编辑：写回 layer.text，落历史 + 广播（内容未变则静默关闭） */
  function commitTextEdit() {
    const edit = editingText;
    if (!edit) return;
    setEditingText(null);
    const layer = textLayersRef.current.find((l) => l.id === edit.id);
    if (!layer || layer.text === edit.value) return;
    const next = textLayersRef.current.map((l) => (l.id === edit.id ? { ...l, text: edit.value } : l));
    setTextLayers(next);
    setDirty(true);
    void pushHistory(next, edit.id);
    broadcastText(next);
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

  /** 导出前确保自定义字体就绪：canvas 绘制不会自动等待 FontFace 加载完成（PNG/PSD 导出共用） */
  async function ensureExportFontsReady() {
    await document.fonts.ready;
    await Promise.all(
      textLayers
        .filter((l) => l.visible !== false && l.fontFamily)
        .map((l) =>
          document.fonts
            .load(`${l.fontWeight} ${l.fontSize}px ${l.fontFamily}`, l.text)
            .catch(() => undefined),
        ),
    );
  }

  // ---- 背景调整：预览（SVG 精确 LUT）与导出（canvas 查表）共用 computeAdjustLut 这一条曲线 ----
  const adjustLut = useMemo(() => computeAdjustLut(adjust), [adjust]);
  const adjustTableValues = useMemo(() => lutToTableValues(adjustLut), [adjustLut]);
  const adjustActive = !isDefaultAdjust(adjust);

  /** 导出前对已绘好背景的画布应用 LUT：只调背景层，涂改层/文字层在调用之后才画（不受影响） */
  function applyBackgroundAdjust(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!adjustActive) return;
    const image = ctx.getImageData(0, 0, w, h);
    applyLutToImageData(image.data, adjustLut);
    ctx.putImageData(image, 0, 0);
  }

  /** 更新背景调整单项：标脏 + 停手后广播。不进撤销栈（全局视图参数，非像素/图层状态） */
  function patchAdjust(patch: Partial<TypesetAdjust>) {
    const next = normalizeAdjust({ ...adjustRef.current, ...patch });
    setAdjust(next);
    setDirty(true);
    scheduleAdjustBroadcast();
  }

  /**
   * 把单个文字层绘制到指定 2d 上下文（renderPngBlob 与 PSD 导出栅格化共用同一份绘制逻辑，
   * 保证导出 PNG 与 PSD 里的文字层像素完全一致）。调用方自行 save/restore 包裹。
   */
  function drawTextLayerOnCtx(ctx: CanvasRenderingContext2D, layer: TypesetTextLayer) {
    ctx.save();
    ctx.font = layerFontExpr(layer);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = layer.strokeWidth;
    ctx.strokeStyle = layer.stroke;
    ctx.fillStyle = layer.color;
    const strokeNew = layer.strokeColor ?? null;
    const shadow = layer.shadowColor ?? null;
    if (strokeNew) {
      // 新描边：宽度按字号比例，圆角连接避免尖角刺出
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(0, (layer.strokeWidthRatio ?? 0.12) * layer.fontSize);
      ctx.strokeStyle = strokeNew;
    }
    if (shadow) {
      // 阴影参数按字号像素换算；方向与 CSS 一致（offsetY 正值向下）
      ctx.shadowColor = shadow;
      ctx.shadowBlur = Math.max(0, (layer.shadowBlurRatio ?? 0.15) * layer.fontSize);
      ctx.shadowOffsetX = (layer.shadowOffset?.x ?? 0) * layer.fontSize;
      ctx.shadowOffsetY = (layer.shadowOffset?.y ?? 0.06) * layer.fontSize;
    }
    /**
     * 单个字形/行的绘制顺序（叠加取舍）：
     * - 有阴影：先带阴影填充（阴影只随填充投影一次），立即清掉阴影再描边，避免描边重复投影糊边；
     * - 无阴影 + 新描边：先填充再描边（描边压在填充上，观感接近 PS 外描边）；
     * - 无阴影 + 旧 px 描边：保持既有「先描后填」顺序，老图层导出效果不变。
     */
    const drawOne = (glyph: string, gx: number, gy: number) => {
      if (shadow) {
        ctx.fillText(glyph, gx, gy);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        if (strokeNew || layer.strokeWidth > 0) ctx.strokeText(glyph, gx, gy);
        return;
      }
      if (strokeNew) {
        ctx.fillText(glyph, gx, gy);
        ctx.strokeText(glyph, gx, gy);
        return;
      }
      if (layer.strokeWidth > 0) ctx.strokeText(glyph, gx, gy);
      ctx.fillText(glyph, gx, gy);
    };
    const originX = layer.x * imageWidth;
    const originY = layer.y * imageHeight;
    const lines = layer.text.split('\n');
    // 字距（px）与纵中横排开关（纵中横排仅竖排生效，横排忽略）
    const spacingPx = (layer.letterSpacing ?? 0) * layer.fontSize;
    const useTcy = layer.tcyEnabled !== false;
    // 竖排逐格布局启用条件：有字距，或开启纵中横排且文本含半角字符段
    const cellVertical =
      layer.vertical && (spacingPx !== 0 || (useTcy && hasHalfWidthChars(layer.text)));
    const hLayout = !layer.vertical ? layoutHorizontal(layer) : null;

    /**
     * transform 组合顺序（与 DOM 侧一致）：translate(anchor) → rotate(R) → scale(S)
     * 即：先按对齐锚点定位（originX/originY + 各分支的锚点语义），再绕「文本块包围盒中心」
     * 旋转，最后缩放（缩放不改变中心）。DOM 侧 transform = translate(anchor) rotate() scale()，
     * transform-origin 默认 = 包围盒中心，与这里的 rotate/scale 中心一一对应。
     * 无旋转无缩放时坐标保持绝对值（ox/oy = originX/originY），老数据渲染路径零变化。
     */
    const rot = layer.rotation ?? 0;
    const scl = layer.scale ?? 1;
    const applyTransform = rot !== 0 || scl !== 1;
    // 包围盒中心：竖排列组上下左右均居中于 (originX, originY)；横排按对齐锚点推算（左=右缘、右=左缘贴锚点）
    let cx = originX;
    let cy = originY;
    if (!layer.vertical) {
      const blockW = hLayout
        ? Math.max(
            0,
            ...hLayout.map(
              (cells) =>
                cells.reduce((sum, c) => sum + c.w, 0) + spacingPx * Math.max(0, cells.length - 1),
            ),
          )
        : Math.max(0, ...lines.map((line) => ctx.measureText(line).width));
      if (layer.align === 'left') cx = originX + blockW / 2;
      else if (layer.align === 'right') cx = originX - blockW / 2;
    }
    if (applyTransform) {
      ctx.translate(cx, cy);
      if (rot !== 0) ctx.rotate((rot * Math.PI) / 180);
      if (scl !== 1) ctx.scale(scl, scl); // 几何缩放：描边/阴影随缩放视觉变粗属预期（PS 同款，非破坏不改 fontSize）
    }
    const ox = applyTransform ? originX - cx : originX;
    const oy = applyTransform ? originY - cy : originY;

    // 渐变填充：fillGradient 非空时忽略纯色 color；方向/跨度用「整个文本块」包围盒（与 DOM 容器盒同口径）：
    // 横排 = 垂直方向上→下（块高 = 行数×字号×行距）；竖排 = 水平方向左→右（块宽 = 列组宽度）
    const grad = layer.fillGradient ?? null;
    if (grad) {
      let g: CanvasGradient;
      if (layer.vertical) {
        const columnGap = layer.fontSize * 0.35;
        const blockW = (lines.length - 1) * (layer.fontSize + columnGap) + layer.fontSize;
        g = ctx.createLinearGradient(ox - blockW / 2, oy, ox + blockW / 2, oy);
      } else {
        const blockH = lines.length * layer.fontSize * layer.lineHeight;
        g = ctx.createLinearGradient(ox, oy - blockH / 2, ox, oy + blockH / 2);
      }
      g.addColorStop(0, grad.from);
      g.addColorStop(1, grad.to);
      ctx.fillStyle = g;
    }
    if (cellVertical) {
      // 竖排逐格布局：每个字符/纵中横段占固定字格，字距 = 字格间距增量。
      // DOM 预览用同一套几何（列宽/字格高/段占格数），保证预览与导出一致。
      const cellH = layer.fontSize * layer.lineHeight + spacingPx;
      const columnGap = layer.fontSize * 0.35;
      const totalWidth = (lines.length - 1) * (layer.fontSize + columnGap);
      // 纵中横段占格数：半角字符按 0.5em 估宽，向上取整到字格（与 DOM 侧同一公式）
      const tcyCells = (runText: string) =>
        Math.max(
          2,
          Math.ceil(
            (runText.length * 0.5 * layer.fontSize) /
              Math.max(1, layer.fontSize * layer.lineHeight),
          ),
        );
      lines.forEach((line, col) => {
        const runs: VerticalRun[] = useTcy
          ? groupVerticalRuns(line)
          : Array.from(line).map((ch) => ({ kind: 'char' as const, text: ch }));
        const advances = runs.map((run) =>
          run.kind === 'char' || run.small ? cellH : tcyCells(run.text) * cellH,
        );
        const colX = ox - totalWidth / 2 + col * (layer.fontSize + columnGap);
        const total = advances.reduce((sum, a) => sum + a, 0);
        let cursor = oy - total / 2;
        runs.forEach((run, ri) => {
          const cy = cursor + advances[ri] / 2;
          if (run.kind === 'char') {
            drawOne(run.text, colX, cy);
          } else {
            // 纵中横排：整段顺时针旋转 90°（≤2 字符占一格，≥3 字符占多格）
            ctx.save();
            ctx.translate(colX, cy);
            ctx.rotate(Math.PI / 2);
            drawOne(run.text, 0, 0);
            ctx.restore();
          }
          cursor += advances[ri];
        });
      });
    } else if (layer.vertical) {
      // 旧竖排路径（无字距、无纵中横排）：保持原样，老数据导出不变
      const columnGap = layer.fontSize * 0.35;
      const totalWidth = (lines.length - 1) * (layer.fontSize + columnGap);
      lines.forEach((line, col) => {
        const colX = ox - totalWidth / 2 + col * (layer.fontSize + columnGap);
        const chars = Array.from(line);
        chars.forEach((ch, i) => {
          const y = oy + (i - (chars.length - 1) / 2) * layer.fontSize * layer.lineHeight;
          drawOne(ch, colX, y);
        });
      });
    } else {
      if (hLayout) {
        // 限宽自动换行 + 字距：逐行逐字符按测量宽度绘制（与 DOM 预览同一套行结果）
        ctx.textAlign = 'left';
        hLayout.forEach((cells, i) => {
          const y = oy + (i - (hLayout.length - 1) / 2) * layer.fontSize * layer.lineHeight;
          const lineWidth =
            cells.reduce((sum, c) => sum + c.w, 0) + spacingPx * Math.max(0, cells.length - 1);
          let x =
            layer.align === 'left'
              ? ox
              : layer.align === 'right'
                ? ox - lineWidth
                : ox - lineWidth / 2;
          cells.forEach((cell) => {
            drawOne(cell.ch, x, y);
            x += cell.w + spacingPx;
          });
        });
      } else {
        // 旧横排路径（不限宽且无字距）：保持原样，老数据导出不变
        ctx.textAlign = layer.align === 'left' ? 'left' : layer.align === 'right' ? 'right' : 'center';
        lines.forEach((line, i) => {
          const y = oy + (i - (lines.length - 1) / 2) * layer.fontSize * layer.lineHeight;
          drawOne(line, ox, y);
        });
      }
    }
    ctx.restore();
  }

  /** 把底图 + 涂改层 + 文字层渲染成 PNG blob（导出 / 写入空间 / 保存成品共用） */
  async function renderPngBlob(): Promise<Blob | null> {
    const img = wrapperRef.current?.querySelector('img') as HTMLImageElement | null;
    const paint = paintRef.current;
    if (!img || !paint) return null;
    await ensureExportFontsReady();
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, imageWidth, imageHeight);
    // 背景层先调完 LUT 再叠涂改层/文字层（非破坏：LUT 只影响合成输出的背景像素）
    applyBackgroundAdjust(ctx, imageWidth, imageHeight);
    ctx.drawImage(paint, 0, 0);
    for (const layer of textLayers) {
      if (layer.visible === false) continue;
      drawTextLayerOnCtx(ctx, layer);
    }
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  }


  /**
   * 把文字层转成 ag-psd 原生 TypeTool 文本图层（PS 打开可直接编辑文字，无需逐层栅格化）。
   * 无法映射的特效返回 null 走栅格兜底（混合输出）：
   * - 渐变填充 / 阴影：PSD 文本样式无单层表达；
   * - 竖排 + 纵中横排：段内字符转正无法用 PS 直排文本表达。
   * 映射口径：字号（×整体缩放）/ 填充色 / 假粗体 / 行距 / 字距 / 描边色（宽度非公开字段不映射）/
   * 横竖排（orientation）/ 对齐（justification，与层锚点语义一一对应）/ 旋转（transform 矩阵 + 绕层中心补偿）。
   * 限宽/字距的横排断行结果写死进文本（PS 端逐行静态换行，文字仍可编辑）。
   */
  function buildTypesetPsdTextLayer(layer: TypesetTextLayer): PsdLayer | null {
    if (layer.fillGradient != null || layer.shadowColor != null) return null;
    if (layer.vertical && layer.tcyEnabled !== false && hasHalfWidthChars(layer.text)) return null;
    const scl = layer.scale ?? 1;
    const bbox = layerBBox(layer);
    const fontSizePx = Math.max(4, layer.fontSize * scl);
    // layerBBox 不含 scale：绕中心缩放补偿（中心不变，与渲染 transform 同口径）
    const cx = bbox.left + bbox.w / 2;
    const cy = bbox.top + bbox.h / 2;
    const bw = Math.max(fontSizePx, bbox.w * scl);
    const bh = Math.max(fontSizePx, bbox.h * scl);
    const left = cx - bw / 2;
    const top = cy - bh / 2;

    const hLayout = !layer.vertical ? layoutHorizontal(layer) : null;
    const text = hLayout
      ? hLayout.map((cells) => cells.map((cell) => cell.ch).join('')).join('\n')
      : layer.text;
    const lineCount = hLayout ? hLayout.length : Math.max(1, layer.text.split('\n').length);

    // 文本原点：
    // - 横排 point text = 对齐锚点（layer.x 的左缘/中心/右缘语义与 PS 对齐锚点一一对应）× 首行基线；
    //   首行基线 ≈ 首行中心（块顶 + 半行高）+ 0.35 字号（CJK 基线近似，PS 端可微调）
    // - 竖排直排文字 = 首列基线 x（列组右缘内缩半字号）× 文本顶部（近似）
    let x: number;
    let y: number;
    if (layer.vertical) {
      x = left + bw - fontSizePx / 2;
      y = top + fontSizePx * 0.8;
    } else {
      x = layer.x * imageWidth;
      y = top + bh / (2 * lineCount) + fontSizePx * 0.35;
    }
    // 旋转中心补偿：PSD transform 的原点取「绕层中心旋转后」的位置（与渲染 transform 同口径）
    const rotDeg = layer.rotation ?? 0;
    if (rotDeg !== 0) {
      const rad = (rotDeg * Math.PI) / 180;
      const dx = x - cx;
      const dy = y - cy;
      x = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
      y = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    }

    // 描边：新描边（strokeColor）优先，回落旧 px 描边；描边宽度非 PSD 可移植字段，仅映射颜色
    const strokeColor = layer.strokeColor ?? (layer.strokeWidth > 0 ? layer.stroke : null);

    // 字体：CSS font-family 栈取第一个名字（自定义字体为带引号名）；PS 缺字自动替换，不影响可编辑性
    let fontName: string | undefined;
    if (layer.fontFamily) {
      const first = layer.fontFamily.split(',')[0]?.trim().replace(/^"|"$/g, '');
      if (first) fontName = first;
    }

    return buildPsdTextLayer({
      name: layer.text.replace(/\n/g, ' ').trim().slice(0, 20) || '文字层',
      text,
      fontSize: fontSizePx,
      color: layer.color,
      bold: layer.fontWeight >= 600,
      leadingPx: fontSizePx * layer.lineHeight,
      tracking: (layer.letterSpacing ?? 0) * 1000,
      strokeColor,
      vertical: layer.vertical,
      rotationDeg: rotDeg,
      align: layer.vertical ? undefined : layer.align,
      x,
      y,
      fontName,
    });
  }

  /**
   * 导出 PSD（ag-psd，RLE 压缩）：图层组装 = 底层原图 → 涂改层（整幅透明像素图层）
   * → 可见文字层：能映射的转 ag-psd 原生 TypeTool 文本图层（PS 打开直接可编辑），
   *   含渐变/阴影/纵中横排的层保持栅格像素图层兜底（混合输出）；
   * 图层名 = 文字内容前 20 字符；逐层离屏绘制后及时释放。
   */
  async function exportPsd() {
    const img = wrapperRef.current?.querySelector('img') as HTMLImageElement | null;
    const paint = paintRef.current;
    if (!img || !paint) return;
    await ensureExportFontsReady();
    const children: PsdLayer[] = [];
    try {
      // 底层：原图（带背景调整 LUT，与 PNG 导出同一条曲线；涂改层/文字层不调）
      const bg = document.createElement('canvas');
      bg.width = imageWidth;
      bg.height = imageHeight;
      const bgCtx = bg.getContext('2d');
      if (bgCtx) {
        bgCtx.drawImage(img, 0, 0, imageWidth, imageHeight);
        applyBackgroundAdjust(bgCtx, imageWidth, imageHeight);
      }
      children.push({ name: '背景原图', canvas: bg });
      // 涂改层：整幅透明像素图层（画布可能为空，导出空图层保持结构完整）
      const paintCopy = document.createElement('canvas');
      paintCopy.width = imageWidth;
      paintCopy.height = imageHeight;
      paintCopy.getContext('2d')?.drawImage(paint, 0, 0);
      children.push({ name: '涂改层', canvas: paintCopy });
      // 文字层：优先转原生 TypeTool（PS 打开直接可编辑文字）；
      // 含渐变/阴影/纵中横排的层无法映射，保持栅格像素图层兜底（混合输出）
      for (const layer of textLayers) {
        if (layer.visible === false) continue;
        const textLayer = buildTypesetPsdTextLayer(layer);
        if (textLayer) {
          children.push(textLayer);
          continue;
        }
        const c = document.createElement('canvas');
        c.width = imageWidth;
        c.height = imageHeight;
        const cctx = c.getContext('2d');
        if (!cctx) continue;
        drawTextLayerOnCtx(cctx, layer);
        children.push({
          name: layer.text.replace(/\n/g, ' ').trim().slice(0, 20) || '文字层',
          canvas: c,
        });
      }
      // 合成图（composite）：PS 打开 PSD 的首屏渲染源。ag-psd 不会从子图层自动合成，
      // 不设置 psd.canvas 时写入的是不透明纯黑图（PS 首屏全黑、像导出失败）——必须手绘。
      // TypeTool 文本层没有像素 canvas，合成时用 drawTextLayerOnCtx 画出（与预览/栅格兜底同口径，
      // 仅用于非 PS 软件预览；PS 内文字层由文本引擎实时渲染）。
      const composite = document.createElement('canvas');
      composite.width = imageWidth;
      composite.height = imageHeight;
      const cctx2 = composite.getContext('2d');
      if (cctx2) {
        cctx2.drawImage(bg, 0, 0);
        cctx2.drawImage(paintCopy, 0, 0);
        for (const layer of textLayers) {
          if (layer.visible === false) continue;
          drawTextLayerOnCtx(cctx2, layer);
        }
      }
      const psd: Psd = { width: imageWidth, height: imageHeight, canvas: composite, children };
      // ag-psd 默认即 RLE 压缩（无损、兼容性最好）；trimImageData 裁掉图层透明边缘减小体积。
      // WriteOptions.compress = ZIP 压缩体积更小但部分软件不兼容，不用。
      const buffer = writePsd(psd, { trimImageData: true });
      // 大图内存：写入完成后立即释放逐层离屏画布引用
      children.forEach((l) => {
        delete (l as { canvas?: HTMLCanvasElement }).canvas;
      });
      children.length = 0;
      const blob = new Blob([buffer], { type: 'image/vnd.adobe.photoshop' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${item?.title || asset?.original_name?.replace(/\.[^.]+$/, '') || 'typeset'}.psd`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('导出 PSD 失败');
    }
  }

  async function exportPng(writeBack: boolean) {
    const blob = await renderPngBlob();
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

  /** 保存成品：PNG blob → base64 → POST，归档到条目的成品列表（不进空间图片列表） */
  async function saveOutput() {
    if (savingOutput) return;
    setSavingOutput(true);
    setOutputNotice(null);
    setError(null);
    try {
      const blob = await renderPngBlob();
      if (!blob) {
        setError('生成成品图失败');
        return;
      }
      // blob → base64：分块拼接，避免大图一次性 String.fromCharCode 溢出调用栈
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      const res = await fetch(`/api/items/${itemId}/outputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: btoa(binary) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '保存成品失败');
        return;
      }
      setOutputNotice(`已保存，本图共 ${data.count} 个成品版本`);
    } catch {
      setError('保存成品失败');
    } finally {
      setSavingOutput(false);
    }
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
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={!selShape}
            title={selShape ? '把当前选区光栅化成蒙版去字（选区内清除，AI/本地引擎补背景）' : '先用「矩形选区 / 套索选区」框出要去的文字区域'}
            onClick={() => void inpaintSelection()}
          >
            选区去字
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={!selShape}
            title={selShape ? '用当前颜色填充选区' : '先用「矩形选区 / 套索选区」框出区域'}
            onClick={() => void fillSelection()}
          >
            填充选区
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
          <button type="button" className="btn-ghost text-xs" onClick={() => void exportPsd()}>
            导出 PSD
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={savingOutput}
            onClick={() => void saveOutput()}
          >
            {savingOutput ? '保存中…' : '保存成品'}
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
      {outputNotice && <p className="notice-ok">{outputNotice}</p>}

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
          <label className="flex items-center gap-1 text-[11px] text-ink-500">
            <input
              type="checkbox"
              checked={softBrush}
              onChange={(e) => setSoftBrush(e.target.checked)}
            />
            软边笔刷
          </label>
          <p className="text-[11px] text-ink-400">
            原图层已锁定。橡皮只擦涂改层。图章(S)：Alt+点击取源，拖动复制背景；软边对画笔/橡皮生效。
            液化：拖动把背景内容沿拖动方向推挤（结果画进涂改层，非破坏；大小=影响域，不透明度=强度）。
            矩形/套索拖出选区后，用顶部「填充选区」上色或「选区去字」去字（Esc 取消选区）。
          </p>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mb-2 flex gap-2 text-xs">
            <button
              type="button"
              className="btn-ghost px-2 py-1"
              onClick={() => {
                userAdjusted.current = false;
                fitToViewport();
              }}
            >
              适应窗口
            </button>
            <button
              type="button"
              className="btn-ghost px-2 py-1"
              onClick={() => {
                userAdjusted.current = true;
                setZoom(1);
              }}
            >
              100%
            </button>
            <button
              type="button"
              className="btn-ghost px-2 py-1"
              onClick={() => {
                userAdjusted.current = true;
                setZoom((z) => Math.min(8, z * 1.25));
              }}
            >
              放大
            </button>
            <button
              type="button"
              className="btn-ghost px-2 py-1"
              onClick={() => {
                userAdjusted.current = true;
                setZoom((z) => Math.max(0.15, z / 1.25));
              }}
            >
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
            <button
              type="button"
              className={`btn-ghost px-2 py-1 ${showGuides ? 'btn-primary' : ''}`}
              onClick={() =>
                setShowGuides((v) => {
                  localStorage.setItem('typeset-guides', v ? '0' : '1');
                  return !v;
                })
              }
              title="三分线 + 5% 安全框（仅预览辅助，不导出）"
            >
              参考线
            </button>
            <span className="text-ink-500">{Math.round(zoom * 100)}% · {imageWidth}×{imageHeight}</span>
          </div>
          <div
            ref={viewportRef}
            className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-sky/20 bg-ink-950"
          >
            {/* 背景调整预览滤镜：feComponentTransfer type=table 256 项 = 导出 canvas LUT 的精确复现（GPU 加速，
                拖滑条不掉帧）。必须 sRGB 插值（默认 linearRGB 会改变曲线），与 applyBackgroundAdjust 同一条曲线 */}
            <svg width="0" height="0" className="absolute" aria-hidden>
              <defs>
                <filter id="typeset-adjust-lut" colorInterpolationFilters="sRGB">
                  <feComponentTransfer>
                    <feFuncR type="table" tableValues={adjustTableValues} />
                    <feFuncG type="table" tableValues={adjustTableValues} />
                    <feFuncB type="table" tableValues={adjustTableValues} />
                  </feComponentTransfer>
                </filter>
              </defs>
            </svg>
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
                onLoad={() => fitToViewport()}
                className="pointer-events-none absolute inset-0 h-full w-full select-none"
                style={adjustActive ? { filter: 'url(#typeset-adjust-lut)' } : undefined}
              />
              <canvas
                ref={paintRef}
                width={imageWidth}
                height={imageHeight}
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
              {textLayers.map((layer) => {
                // 特效的 DOM 预览：strokeColor 非空走新描边（字号比例），否则回落旧 px 描边
                const strokeCss = layer.strokeColor
                  ? `${(layer.strokeWidthRatio ?? 0.12) * layer.fontSize}px ${layer.strokeColor}`
                  : `${layer.strokeWidth / 2}px ${layer.stroke}`;
                const shadowCss = layer.shadowColor
                  ? `${(layer.shadowOffset?.x ?? 0) * layer.fontSize}px ${
                      (layer.shadowOffset?.y ?? 0.06) * layer.fontSize
                    }px ${(layer.shadowBlurRatio ?? 0.15) * layer.fontSize}px ${layer.shadowColor}`
                  : undefined;
                const selectedCls = selectedText === layer.id ? 'outline outline-2 outline-halo' : '';
                // 渐变填充：非空时忽略纯色 color（color 透明 + background-clip:text），方向与导出同口径：
                // 横排 = 线性 to bottom（跨文本块高），竖排 = to right（跨文本块宽），描边/阴影照常叠加
                const grad = layer.fillGradient ?? null;
                const gradCss = grad
                  ? layer.vertical
                    ? `linear-gradient(to right, ${grad.from}, ${grad.to})`
                    : `linear-gradient(to bottom, ${grad.from}, ${grad.to})`
                  : undefined;
                const commonStyle = {
                  left: `${layer.x * 100}%`,
                  top: `${layer.y * 100}%`,
                  color: grad ? ('transparent' as const) : layer.color,
                  ...(grad
                    ? {
                        backgroundImage: gradCss,
                        WebkitBackgroundClip: 'text' as const,
                        WebkitTextFillColor: 'transparent' as const,
                      }
                    : {}),
                  fontSize: layer.fontSize,
                  fontWeight: layer.fontWeight,
                  WebkitTextStroke: strokeCss,
                  textShadow: shadowCss,
                  fontFamily: `${layer.fontFamily ? `${layer.fontFamily}, ` : ''}"Noto Sans SC", sans-serif`,
                  display: layer.visible === false ? ('none' as const) : undefined,
                  pointerEvents: tool === 'text' ? ('auto' as const) : ('none' as const),
                  cursor: tool === 'text' ? ('move' as const) : undefined,
                };
                /**
                 * transform 组合顺序（与 canvas 导出一致）：translate(anchor) → rotate(R) → scale(S)
                 * 先按对齐锚点定位，再绕包围盒中心旋转（transform-origin 默认 = 中心），最后缩放。
                 * 选中描边框在容器上，自动跟随旋转。无旋转/缩放时 suffix 为空串，老数据行为不变。
                 */
                const rot = layer.rotation ?? 0;
                const scl = layer.scale ?? 1;
                const transformSuffix = `${rot !== 0 ? ` rotate(${rot}deg)` : ''}${
                  scl !== 1 ? ` scale(${scl})` : ''
                }`;
                const onLayerPointerDown = (event: React.PointerEvent) => {
                  if (tool !== 'text') return;
                  event.stopPropagation();
                  // Shift+点击：追加/移除多选，不启动拖拽
                  if (event.shiftKey) {
                    selectLayer(layer.id, true);
                    return;
                  }
                  if (!selectedIdsRef.current.includes(layer.id)) setSelection([layer.id]);
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
                };

                // 横排限宽自动换行 + 字距：逐行逐字符布局（与导出共用同一套断行/测量结果）
                const hLayout = !layer.vertical ? layoutHorizontal(layer) : null;
                if (hLayout) {
                  const spacingPx = (layer.letterSpacing ?? 0) * layer.fontSize;
                  // 水平对齐锚点与 canvas 导出一致：左对齐=行首贴 originX，右对齐=行尾贴 originX，
                  // 居中=容器中心贴 originX（canvas 侧见 renderPngBlob 的 align 分支）
                  const anchorX =
                    layer.align === 'left' ? '0%' : layer.align === 'right' ? '-100%' : '-50%';
                  return (
                    <div
                      key={layer.id}
                      className={`absolute ${selectedCls}`}
                      style={{
                        ...commonStyle,
                        transform: `translate(${anchorX}, -50%)${transformSuffix}`,
                        lineHeight: layer.lineHeight,
                        display: layer.visible === false ? 'none' : 'flex',
                        flexDirection: 'column',
                        alignItems:
                          layer.align === 'left' ? 'flex-start' : layer.align === 'right' ? 'flex-end' : 'center',
                      }}
                      onPointerDown={onLayerPointerDown}
                      onDoubleClick={openTextEdit(layer)}
                    >
                      {hLayout.map((cells, i) => (
                        <div key={i} style={{ display: 'flex', whiteSpace: 'pre' }}>
                          {cells.map((cell, j) => (
                            <span
                              key={j}
                              style={{
                                display: 'inline-block',
                                width: cell.w,
                                marginRight: j < cells.length - 1 ? spacingPx : 0,
                                textAlign: 'center',
                              }}
                            >
                              {cell.ch}
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                  );
                }

                // 竖排逐格布局：字距 / 纵中横排（与导出共用同一套几何公式）
                if (layer.vertical) {
                  const fs = layer.fontSize;
                  const spacingPx = (layer.letterSpacing ?? 0) * fs;
                  const useTcy = layer.tcyEnabled !== false;
                  if (spacingPx !== 0 || (useTcy && hasHalfWidthChars(layer.text))) {
                    const cellH = fs * layer.lineHeight + spacingPx;
                    const columnGap = fs * 0.35;
                    const tcyCells = (runText: string) =>
                      Math.max(
                        2,
                        Math.ceil((runText.length * 0.5 * fs) / Math.max(1, fs * layer.lineHeight)),
                      );
                    const columns = layer.text.split('\n').map((line) =>
                      useTcy
                        ? groupVerticalRuns(line)
                        : Array.from(line).map((ch) => ({ kind: 'char' as const, text: ch })),
                    );
                    const colHeights = columns.map((runs) =>
                      runs.reduce(
                        (sum, run) => sum + (run.kind === 'char' || run.small ? cellH : tcyCells(run.text) * cellH),
                        0,
                      ),
                    );
                    const containerW = (columns.length - 1) * (fs + columnGap) + fs;
                    const containerH = Math.max(fs, ...colHeights);
                    return (
                      <div
                        key={layer.id}
                        className={`absolute ${selectedCls}`}
                        style={{ ...commonStyle, transform: `translate(-50%, -50%)${transformSuffix}` }}
                        onPointerDown={onLayerPointerDown}
                        onDoubleClick={openTextEdit(layer)}
                      >
                        <div style={{ position: 'relative', width: containerW, height: containerH }}>
                          {columns.map((runs, col) => (
                            <div
                              key={col}
                              style={{
                                position: 'absolute',
                                left: col * (fs + columnGap),
                                top: '50%',
                                transform: 'translateY(-50%)',
                                width: fs,
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                              }}
                            >
                              {runs.map((run, ri) => {
                                const h = run.kind === 'char' || run.small ? cellH : tcyCells(run.text) * cellH;
                                return (
                                  <div
                                    key={ri}
                                    style={{
                                      height: h,
                                      width: '100%',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    }}
                                  >
                                    {run.kind === 'char' ? (
                                      <span style={{ lineHeight: 1 }}>{run.text}</span>
                                    ) : run.small ? (
                                      // 纵中横排（≤2 字符）：顺时针旋转 90°，占一个字格
                                      <span
                                        style={{ display: 'inline-block', transform: 'rotate(90deg)', whiteSpace: 'nowrap', lineHeight: 1 }}
                                      >
                                        {run.text}
                                      </span>
                                    ) : (
                                      // 纵中横排（≥3 字符）：整段横倒，占竖向多格
                                      <span style={{ writingMode: 'vertical-rl', textOrientation: 'sideways', lineHeight: 1 }}>
                                        {run.text}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }
                }

                // 旧路径（不限宽且无字距的横排 / 无字距无纵中横排的竖排）：保持原有 CSS 行为
                return (
                  <div
                    key={layer.id}
                    className={`absolute max-w-[40%] whitespace-pre-wrap ${
                      layer.vertical ? 'text-start' : 'text-center'
                    } ${selectedCls}`}
                    style={{
                      ...commonStyle,
                      transform: `translate(-50%, -50%)${transformSuffix}`,
                      lineHeight: layer.lineHeight,
                      writingMode: layer.vertical ? 'vertical-rl' : 'horizontal-tb',
                    }}
                    onPointerDown={onLayerPointerDown}
                    onDoubleClick={openTextEdit(layer)}
                  >
                    {layer.text}
                  </div>
                );
              })}
              {/* 主选中文字层的画布变换手柄：8 向（角/上下 = 等比缩放、左右 = 限宽；竖排层隐藏左右）
                  + 顶部旋转柄（绕包围盒中心）。overlay 按视觉包围盒（bbox×scale）定位并随 rotation 旋转；
                  手柄尺寸乘 1/zoom 保持视觉恒定（与标注编辑器同风格）。
                  仅文字工具 + 可编辑时显示，避免挡其它工具的操作。 */}
              {tool === 'text' && canEdit && selected && (() => {
                const bbox = layerBBox(selected);
                const scl = selected.scale ?? 1;
                const w = Math.max(24, bbox.w * scl);
                const h = Math.max(14, bbox.h * scl);
                const left = bbox.left + bbox.w / 2 - w / 2;
                const top = bbox.top + bbox.h / 2 - h / 2;
                const inverse = 1 / zoom;
                const hs = 10 * inverse;
                const rotGap = 26 * inverse;
                const positions: Record<TextHandle, { left: number; top: number }> = {
                  nw: { left: 0, top: 0 },
                  n: { left: w / 2, top: 0 },
                  ne: { left: w, top: 0 },
                  e: { left: w, top: h / 2 },
                  se: { left: w, top: h },
                  s: { left: w / 2, top: h },
                  sw: { left: 0, top: h },
                  w: { left: 0, top: h / 2 },
                };
                const activeHandles: TextHandle[] = selected.vertical
                  ? TEXT_HANDLES.filter((hd) => hd !== 'e' && hd !== 'w')
                  : [...TEXT_HANDLES];
                return (
                  <div
                    className="pointer-events-none absolute"
                    style={{
                      left,
                      top,
                      width: w,
                      height: h,
                      transform: `rotate(${selected.rotation ?? 0}deg)`,
                      transformOrigin: '50% 50%',
                    }}
                  >
                    {/* 旋转连接线 + 旋转柄（顶部中点上方延伸，样式与标注编辑器手柄同色系） */}
                    <div
                      className="absolute bg-white/60"
                      style={{ left: w / 2 - inverse, top: -rotGap, width: 2 * inverse, height: rotGap }}
                    />
                    <div
                      className="pointer-events-auto absolute rounded-full border border-white bg-brand-400"
                      style={{
                        left: w / 2,
                        top: -rotGap,
                        width: hs,
                        height: hs,
                        marginLeft: -hs / 2,
                        marginTop: -hs / 2,
                        cursor: 'grab',
                        touchAction: 'none',
                      }}
                      onPointerDown={(e) => startHandleDrag(e, selected, 'rotate')}
                      title="拖拽旋转"
                    />
                    {activeHandles.map((handle) => (
                      <div
                        key={handle}
                        className="pointer-events-auto absolute rounded-[2px] border border-white bg-brand-400"
                        style={{
                          left: positions[handle].left,
                          top: positions[handle].top,
                          width: hs,
                          height: hs,
                          marginLeft: -hs / 2,
                          marginTop: -hs / 2,
                          cursor: CURSOR_BY_TEXT_HANDLE[handle],
                          touchAction: 'none',
                        }}
                        onPointerDown={(e) =>
                          startHandleDrag(
                            e,
                            selected,
                            handle === 'e' || handle === 'w' ? 'width' : 'scale',
                          )
                        }
                        title={
                          handle === 'e' || handle === 'w'
                            ? '拖拽调整限宽'
                            : '拖拽等比缩放'
                        }
                      />
                    ))}
                  </div>
                );
              })()}
              {/* 双击就地编辑：textarea 水平定位在层包围盒上（不随旋转，规格允许），字体/颜色/行高/对齐跟随层 */}
              {editingText &&
                (() => {
                  const layer = textLayers.find((l) => l.id === editingText.id);
                  if (!layer) return null;
                  const bbox = layerBBox(layer);
                  const scl = layer.scale ?? 1;
                  const w = Math.max(80, bbox.w * scl);
                  const h = Math.max(layer.fontSize * scl * 1.6, bbox.h * scl);
                  const left = bbox.left + bbox.w / 2 - w / 2;
                  const top = bbox.top + bbox.h / 2 - h / 2;
                  return (
                    <textarea
                      autoFocus
                      className="absolute z-30 rounded border border-halo bg-cloud/95 p-1 shadow-card outline-none"
                      style={{
                        left,
                        top,
                        width: w,
                        height: h,
                        fontSize: layer.fontSize * scl,
                        fontWeight: layer.fontWeight,
                        lineHeight: layer.lineHeight,
                        color: layer.color,
                        textAlign: layer.align,
                        fontFamily: `${layer.fontFamily ? `${layer.fontFamily}, ` : ''}"Noto Sans SC", sans-serif`,
                        resize: 'none',
                      }}
                      value={editingText.value}
                      onChange={(e) => setEditingText({ id: editingText.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        // Enter 提交（Shift+Enter 换行）；Esc 取消
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          commitTextEdit();
                        } else if (e.key === 'Escape') {
                          setEditingText(null);
                        }
                      }}
                      onBlur={() => commitTextEdit()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  );
                })()}
              {rect && (
                <div
                  className="pointer-events-none absolute border border-halo bg-halo/20"
                  style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                />
              )}
              {/* 持久选区预览：拖拽中的 rect/lasso 走上面的临时预览，松手后用这里的虚线框常驻显示 */}
              {selShape?.kind === 'rect' && (
                <div
                  className="pointer-events-none absolute border border-dashed border-halo"
                  style={{ left: selShape.x, top: selShape.y, width: selShape.w, height: selShape.h }}
                />
              )}
              {selShape?.kind === 'lasso' && selShape.points.length > 2 && (
                <svg
                  className="pointer-events-none absolute inset-0"
                  width={imageWidth}
                  height={imageHeight}
                  aria-hidden
                >
                  <polygon
                    points={selShape.points.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="rgba(255,255,255,0.12)"
                    stroke="#7DD3FC"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                  />
                </svg>
              )}
              {showGuides && (
                <div className="pointer-events-none absolute inset-0 z-20">
                  {/* 安全框：距边缘 5% 的虚线框（仅预览辅助，不进导出） */}
                  <div
                    className="absolute border border-dashed border-amber-400/70"
                    style={{ left: '5%', top: '5%', right: '5%', bottom: '5%' }}
                  />
                  {/* 三分线 */}
                  <div className="absolute bottom-0 top-0 w-px bg-amber-300/50" style={{ left: '33.333%' }} />
                  <div className="absolute bottom-0 top-0 w-px bg-amber-300/50" style={{ left: '66.667%' }} />
                  <div className="absolute left-0 right-0 h-px bg-amber-300/50" style={{ top: '33.333%' }} />
                  <div className="absolute left-0 right-0 h-px bg-amber-300/50" style={{ top: '66.667%' }} />
                </div>
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

          {/* 背景调整：非破坏（只存草稿 meta + 导出时对背景层应用 LUT，不碰原图/涂改/文字层数据） */}
          <details className="mt-2 rounded bg-paper px-2 py-1 text-[11px] text-ink-500" open={adjustActive}>
            <summary className="cursor-pointer select-none font-medium">背景调整{adjustActive ? ' · 已启用' : ''}</summary>
            <div className="mt-2 space-y-2">
              {ADJUST_SLIDERS.map(({ key, label, min, max, step }) => (
                <label key={key} className="block">
                  {label} {adjust[key].toFixed(2)}
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={adjust[key]}
                    disabled={!canEdit}
                    onChange={(e) => patchAdjust({ [key]: Number(e.target.value) })}
                    className="mt-1 w-full accent-sky"
                  />
                </label>
              ))}
              <button
                type="button"
                className="btn-ghost w-full py-0.5 text-[10px]"
                disabled={!adjustActive || !canEdit}
                onClick={() => {
                  setAdjust(DEFAULT_ADJUST);
                  setDirty(true);
                  scheduleAdjustBroadcast();
                }}
              >
                恢复默认
              </button>
              <p className="text-[10px] text-ink-400">仅影响背景与导出结果，不改动原图与文字颜色。</p>
            </div>
          </details>

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
                    selectedIds.includes(layer.id) ? 'bg-sky/15' : 'bg-paper'
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
                    className={`min-w-0 flex-1 truncate text-left text-[11px] hover:text-ink-100 ${
                      selectedIds.includes(layer.id) ? 'text-sky-deep' : 'text-ink-200'
                    }`}
                    onClick={(e) => {
                      setTool('text');
                      selectLayer(layer.id, e.shiftKey);
                    }}
                    title="选中该层（Shift+点击追加多选；切换到文字工具可拖动）"
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
              {selectedIds.length > 1 && (
                <p className="rounded bg-sky/15 px-2 py-1 text-[11px] text-sky-deep">
                  已选 {selectedIds.length} 层（字号/字体/填充/特效等改动批量应用）
                </p>
              )}
              {selectedIds.length <= 1 && (
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
              )}
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

              {/* 字体：默认 / 系统预设 / 自定义上传（上传成功后注册并自动选中） */}
              <label className="block text-[11px] text-ink-500">
                字体
                <span className="mt-1 flex items-center gap-1">
                  <select
                    className="input h-7 min-w-0 flex-1 text-xs"
                    value={selected.fontFamily ?? ''}
                    onChange={(e) =>
                      patchLayer(selected.id, { fontFamily: e.target.value || undefined })
                    }
                  >
                    <option value="">默认字体</option>
                    <optgroup label="系统">
                      {SYSTEM_FONT_OPTIONS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </optgroup>
                    {fontList.length > 0 && (
                      <optgroup label="自定义">
                        {fontList.map((name) => (
                          <option key={name} value={JSON.stringify(name)}>
                            {name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <button
                    type="button"
                    className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10px]"
                    disabled={fontUploading}
                    title="上传 .ttf/.otf/.woff/.woff2（≤30MB）"
                    onClick={() => fontInputRef.current?.click()}
                  >
                    {fontUploading ? '…' : '上传'}
                  </button>
                  <input
                    ref={fontInputRef}
                    type="file"
                    accept=".ttf,.otf,.woff,.woff2"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void uploadFont(file);
                    }}
                  />
                </span>
              </label>

              {/* 宽度：横排限宽自动换行（相对画布宽度比例 0.05~1），不限宽保持手动 \n 断行 */}
              <div className="text-[11px] text-ink-500">
                <span className="flex items-center justify-between">
                  <span>宽度 {selected.width != null ? `${Math.round(selected.width * 100)}%` : '不限宽'}</span>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={selected.width != null}
                      onChange={(e) => patchLayer(selected.id, { width: e.target.checked ? 0.5 : null })}
                    />
                    限宽
                  </label>
                </span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={selected.width ?? 0.5}
                  disabled={selected.width == null}
                  onChange={(e) => patchLayer(selected.id, { width: Number(e.target.value) }, true)}
                  className="mt-1 w-full accent-sky"
                />
              </div>

              {/* 字距：横排 = 字间距，竖排 = 字格间距（相对字号比例） */}
              <label className="block text-[11px] text-ink-500">
                字距 {(selected.letterSpacing ?? 0).toFixed(2)}
                <input
                  type="range"
                  min={-0.2}
                  max={0.5}
                  step={0.01}
                  value={selected.letterSpacing ?? 0}
                  onChange={(e) => patchLayer(selected.id, { letterSpacing: Number(e.target.value) }, true)}
                  className="mt-1 w-full accent-sky"
                />
              </label>

              {/* 填充：纯色（color）与渐变（fillGradient）互斥，开启渐变后忽略纯色 */}
              <div className="space-y-1 rounded-md border border-ink-700 p-2 text-[11px] text-ink-500">
                <span className="flex items-center justify-between">
                  <span>填充</span>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={selected.fillGradient != null}
                      onChange={(e) =>
                        patchLayer(selected.id, {
                          fillGradient: e.target.checked
                            ? { from: selected.color || '#243044', to: '#FFFFFF' }
                            : null,
                        })
                      }
                    />
                    渐变
                  </label>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-8 shrink-0">纯色</span>
                  <input
                    type="color"
                    className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent"
                    value={selected.color}
                    disabled={selected.fillGradient != null}
                    title={selected.fillGradient != null ? '已启用渐变，纯色被忽略' : '纯色填充'}
                    onChange={(e) => patchLayer(selected.id, { color: e.target.value }, true)}
                  />
                  {selected.fillGradient != null && (
                    <>
                      <input
                        type="color"
                        className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent"
                        value={selected.fillGradient.from}
                        title="渐变起点色"
                        onChange={(e) =>
                          patchLayer(
                            selected.id,
                            { fillGradient: { ...selected.fillGradient!, from: e.target.value } },
                            true,
                          )
                        }
                      />
                      <span className="shrink-0">→</span>
                      <input
                        type="color"
                        className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent"
                        value={selected.fillGradient.to}
                        title="渐变终点色"
                        onChange={(e) =>
                          patchLayer(
                            selected.id,
                            { fillGradient: { ...selected.fillGradient!, to: e.target.value } },
                            true,
                          )
                        }
                      />
                    </>
                  )}
                </span>
              </div>

              {/* 旋转：任意角度，绕文本块包围盒中心（滑杆连续合并，重置离散入栈） */}
              <div className="text-[11px] text-ink-500">
                <span className="flex items-center justify-between">
                  <span>旋转 {Math.round(selected.rotation ?? 0)}°</span>
                  <button
                    type="button"
                    className="btn-ghost px-1.5 py-0.5 text-[10px]"
                    disabled={(selected.rotation ?? 0) === 0}
                    onClick={() => patchLayer(selected.id, { rotation: 0 })}
                  >
                    0°
                  </button>
                </span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  value={selected.rotation ?? 0}
                  onChange={(e) => patchLayer(selected.id, { rotation: Number(e.target.value) }, true)}
                  className="mt-1 w-full accent-sky"
                />
              </div>

              {/* 缩放：非破坏几何缩放（不改 fontSize）；描边/阴影随缩放视觉变粗属预期（PS 同款） */}
              <div className="text-[11px] text-ink-500">
                <span className="flex items-center justify-between">
                  <span>缩放 {Math.round((selected.scale ?? 1) * 100)}%</span>
                  <button
                    type="button"
                    className="btn-ghost px-1.5 py-0.5 text-[10px]"
                    disabled={(selected.scale ?? 1) === 1}
                    onClick={() => patchLayer(selected.id, { scale: 1 })}
                  >
                    100%
                  </button>
                </span>
                <input
                  type="range"
                  min={0.2}
                  max={4}
                  step={0.05}
                  value={selected.scale ?? 1}
                  onChange={(e) => patchLayer(selected.id, { scale: Number(e.target.value) }, true)}
                  className="mt-1 w-full accent-sky"
                />
              </div>

              {/* 纵中横排：竖排半角字符段转正（仅竖排层显示） */}
              {selected.vertical && (
                <button
                  type="button"
                  className={`btn-ghost w-full py-1 text-xs ${selected.tcyEnabled ?? true ? 'btn-primary' : ''}`}
                  onClick={() => patchLayer(selected.id, { tcyEnabled: !(selected.tcyEnabled ?? true) })}
                >
                  纵中横排 {(selected.tcyEnabled ?? true) ? '开' : '关'}
                </button>
              )}

              {/* 文字特效：描边与阴影（宽度/模糊/偏移均为字号比例，随保存/广播/撤销链路走） */}
              <div className="space-y-2 rounded-md border border-ink-700 p-2">
                <span className="block text-[11px] text-ink-500">特效</span>

                {/* 描边：颜色 + 清除「无」 + 宽度（字号比例） */}
                <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
                  <span className="w-8 shrink-0">描边</span>
                  <input
                    type="color"
                    className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent"
                    value={selected.strokeColor ?? '#FFFFFF'}
                    disabled={selected.strokeColor == null}
                    title={selected.strokeColor == null ? '先点「无」旁的启用' : '描边颜色'}
                    onChange={(e) => patchLayer(selected.id, { strokeColor: e.target.value }, true)}
                  />
                  <button
                    type="button"
                    className={`btn-ghost shrink-0 px-1.5 py-0.5 text-[10px] ${selected.strokeColor ? '' : 'btn-primary'}`}
                    title={selected.strokeColor ? '清除描边' : '描边已关闭'}
                    onClick={() =>
                      patchLayer(selected.id, {
                        strokeColor: selected.strokeColor ? null : '#FFFFFF',
                      })
                    }
                  >
                    {selected.strokeColor ? '无' : '启用'}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={selected.strokeWidthRatio ?? 0.12}
                    disabled={selected.strokeColor == null}
                    onChange={(e) =>
                      patchLayer(selected.id, { strokeWidthRatio: Number(e.target.value) }, true)
                    }
                    className="min-w-0 flex-1 accent-sky"
                  />
                  <span className="w-9 shrink-0 text-right">
                    {Math.round((selected.strokeWidthRatio ?? 0.12) * 100)}%
                  </span>
                </div>

                {/* 阴影：颜色 + 清除「无」 + 模糊 / 偏移 X / 偏移 Y */}
                <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
                  <span className="w-8 shrink-0">阴影</span>
                  <input
                    type="color"
                    className="h-6 w-8 cursor-pointer rounded border border-ink-700 bg-transparent"
                    value={selected.shadowColor ?? '#000000'}
                    disabled={selected.shadowColor == null}
                    title={selected.shadowColor == null ? '阴影已关闭' : '阴影颜色'}
                    onChange={(e) => patchLayer(selected.id, { shadowColor: e.target.value }, true)}
                  />
                  <button
                    type="button"
                    className={`btn-ghost shrink-0 px-1.5 py-0.5 text-[10px] ${selected.shadowColor ? '' : 'btn-primary'}`}
                    title={selected.shadowColor ? '清除阴影' : '阴影已关闭'}
                    onClick={() =>
                      patchLayer(selected.id, {
                        shadowColor: selected.shadowColor ? null : '#000000',
                      })
                    }
                  >
                    {selected.shadowColor ? '无' : '启用'}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={selected.shadowBlurRatio ?? 0.15}
                    disabled={selected.shadowColor == null}
                    onChange={(e) =>
                      patchLayer(selected.id, { shadowBlurRatio: Number(e.target.value) }, true)
                    }
                    className="min-w-0 flex-1 accent-sky"
                    title="模糊"
                  />
                  <span className="w-9 shrink-0 text-right">
                    {Math.round((selected.shadowBlurRatio ?? 0.15) * 100)}%
                  </span>
                </div>
                {selected.shadowColor != null && (
                  <div className="space-y-1">
                    <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
                      <span className="w-8 shrink-0">偏移X</span>
                      <input
                        type="range"
                        min={-0.5}
                        max={0.5}
                        step={0.01}
                        value={selected.shadowOffset?.x ?? 0}
                        onChange={(e) =>
                          patchLayer(
                            selected.id,
                            { shadowOffset: { ...(selected.shadowOffset ?? { x: 0, y: 0.06 }), x: Number(e.target.value) } },
                            true,
                          )
                        }
                        className="min-w-0 flex-1 accent-sky"
                      />
                      <span className="w-9 shrink-0 text-right">
                        {Math.round((selected.shadowOffset?.x ?? 0) * 100)}%
                      </span>
                    </label>
                    <label className="flex items-center gap-1.5 text-[11px] text-ink-500">
                      <span className="w-8 shrink-0">偏移Y</span>
                      <input
                        type="range"
                        min={-0.5}
                        max={0.5}
                        step={0.01}
                        value={selected.shadowOffset?.y ?? 0.06}
                        onChange={(e) =>
                          patchLayer(
                            selected.id,
                            { shadowOffset: { ...(selected.shadowOffset ?? { x: 0, y: 0.06 }), y: Number(e.target.value) } },
                            true,
                          )
                        }
                        className="min-w-0 flex-1 accent-sky"
                      />
                      <span className="w-9 shrink-0 text-right">
                        {Math.round((selected.shadowOffset?.y ?? 0.06) * 100)}%
                      </span>
                    </label>
                  </div>
                )}
              </div>
              {/* 对齐：多选（≥2 层）时按选中层包围盒对齐（改 x/y，锚点语义不变） */}
              {selectedIds.length >= 2 && (
                <div className="flex flex-wrap gap-1 text-[11px] text-ink-500">
                  <span className="w-full">对齐</span>
                  {(
                    [
                      ['left', '左'],
                      ['centerH', '水平中'],
                      ['right', '右'],
                      ['top', '顶'],
                      ['centerV', '垂直中'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className="btn-ghost px-1.5 py-0.5 text-[10px]"
                      onClick={() => alignLayers(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={`btn-ghost py-1 text-xs ${selected.vertical ? 'btn-primary' : ''}`}
                  onClick={() => patchLayer(selected.id, { vertical: !selected.vertical })}
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
                onClick={() => setConfirmDeleteLayer(true)}
              >
                删除文字层
              </button>
            </div>
          )}
        </aside>
      </div>
      <ConfirmDialog
        open={confirmDeleteLayer}
        title="删除文字层"
        message={
          selectedIdsRef.current.length > 1
            ? `确认删除选中的 ${selectedIdsRef.current.length} 个文字层？可用 Ctrl+Z 撤销，但保存后将无法恢复。`
            : `确认删除选中的文字层「${selected?.text?.slice(0, 20) ?? ''}」？可用 Ctrl+Z 撤销，但保存后将无法恢复。`
        }
        onConfirm={() => {
          setConfirmDeleteLayer(false);
          const ids = selectedIdsRef.current.length > 0 ? selectedIdsRef.current : (selected ? [selected.id] : []);
          if (ids.length === 0) return;
          clearCoalesce();
          const next = textLayersRef.current.filter((l) => !ids.includes(l.id));
          setTextLayers(next);
          setSelection([]);
          setDirty(true);
          void pushHistory(next, null);
          broadcastText(next);
        }}
        onCancel={() => setConfirmDeleteLayer(false)}
      />
    </div>
  );
}
