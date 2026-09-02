'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from '@/components/EmptyState';
import { isPin } from '@/lib/annotation';
import { originalUrl } from '@/lib/media';
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

export default function TypesetEditor({ itemId }: { itemId: number }) {
  const router = useRouter();
  const viewportRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<Blob[]>([]);
  const histIndex = useRef(-1);
  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const cloneOrigin = useRef<{ x: number; y: number } | null>(null);
  const cloneDelta = useRef<{ x: number; y: number } | null>(null);
  const lassoPts = useRef<{ x: number; y: number }[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<SpaceItem | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [spaceName, setSpaceName] = useState('');
  const [access, setAccess] = useState<SpaceAccess | null>(null);
  const [tool, setTool] = useState<Tool>('brush');
  const [color, setColor] = useState('#FFFFFF');
  const [size, setSize] = useState(24);
  const [textLayers, setTextLayers] = useState<TypesetTextLayer[]>([]);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hasPaint, setHasPaint] = useState(false);

  const imageWidth = asset?.width ?? 1200;
  const imageHeight = asset?.height ?? 800;
  const canEdit = access?.canEdit ?? false;

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

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(true);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undoRef.current();
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

  async function snapshotPaint() {
    const canvas = paintRef.current;
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    historyRef.current = historyRef.current.slice(0, histIndex.current + 1);
    historyRef.current.push(blob);
    if (historyRef.current.length > 50) historyRef.current.shift();
    histIndex.current = historyRef.current.length - 1;
  }

  async function undo() {
    if (histIndex.current <= 0) {
      const canvas = paintRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      histIndex.current = -1;
      setDirty(true);
      return;
    }
    histIndex.current -= 1;
    const blob = historyRef.current[histIndex.current];
    const canvas = paintRef.current;
    const ctx = canvas?.getContext('2d');
    if (!blob || !canvas || !ctx) return;
    const bmp = await createImageBitmap(blob);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    setDirty(true);
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

  function stamp(ctx: CanvasRenderingContext2D, x: number, y: number, erase: boolean) {
    ctx.save();
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
      setTextLayers((prev) => [...prev, layer]);
      setSelectedText(layer.id);
      setDirty(true);
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
    }
    if (tool === 'rect') setRect({ x: pt.x, y: pt.y, w: 0, h: 0 });
    if (tool === 'lasso') lassoPts.current = [pt];
    if (tool === 'clone' && cloneOrigin.current) {
      cloneDelta.current = { x: pt.x - cloneOrigin.current.x, y: pt.y - cloneOrigin.current.y };
    }
  }

  function onPointerMove(event: React.PointerEvent) {
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
    }
    if (tool === 'rect' && lastPt.current) {
      setRect({
        x: Math.min(lastPt.current.x, pt.x),
        y: Math.min(lastPt.current.y, pt.y),
        w: Math.abs(pt.x - lastPt.current.x),
        h: Math.abs(pt.y - lastPt.current.y),
      });
    }
    if (tool === 'lasso') lassoPts.current.push(pt);
    if (tool === 'clone' && cloneDelta.current) {
      const src = { x: pt.x - cloneDelta.current.x, y: pt.y - cloneDelta.current.y };
      const img = wrapperRef.current?.querySelector('img') as HTMLImageElement | null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size / 2, 0, Math.PI * 2);
      ctx.clip();
      if (img) ctx.drawImage(img, src.x - pt.x, src.y - pt.y);
      ctx.drawImage(ctx.canvas, src.x - pt.x, src.y - pt.y);
      ctx.restore();
      setDirty(true);
    }
  }

  async function onPointerUp() {
    if (!drawing.current) return;
    drawing.current = false;
    const ctx = paintCtx();
    if (tool === 'rect' && rect && ctx && rect.w > 2 && rect.h > 2) {
      ctx.fillStyle = color;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      setDirty(true);
    }
    if (tool === 'lasso' && ctx && lassoPts.current.length > 2) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(lassoPts.current[0].x, lassoPts.current[0].y);
      lassoPts.current.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();
      setDirty(true);
    }
    setRect(null);
    lassoPts.current = [];
    lastPt.current = null;
    if (['brush', 'eraser', 'rect', 'lasso', 'clone'].includes(tool)) await snapshotPaint();
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
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }
  saveRef.current = save;
  undoRef.current = undo;

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
    await snapshotPaint();
  }

  async function fromPins() {
    const res = await fetch(`/api/items/${itemId}/annotations`);
    const data = await res.json();
    const pins = (data.annotations ?? []).filter(isPin);
    const generated: TypesetTextLayer[] = pins
      .filter((p: { text: string }) => p.text.trim())
      .map((p: { x: number; y: number; text: string; group_id: number }) => ({
        id: newLayerId(),
        x: p.x,
        y: p.y,
        text: p.text,
        fontSize: Math.max(18, imageHeight * 0.032),
        fontWeight: 700,
        color: p.group_id === 2 ? '#1F64B8' : '#243044',
        stroke: '#FFFFFF',
        strokeWidth: 4,
        align: 'center' as const,
        lineHeight: 1.25,
      }));
    setTextLayers((prev) => [...prev, ...generated]);
    setDirty(true);
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
      ctx.font = `${layer.fontWeight} ${layer.fontSize}px "Noto Sans SC", sans-serif`;
      ctx.textAlign = layer.align;
      ctx.textBaseline = 'middle';
      ctx.lineWidth = layer.strokeWidth;
      ctx.strokeStyle = layer.stroke;
      ctx.fillStyle = layer.color;
      const lines = layer.text.split('\n');
      lines.forEach((line, i) => {
        const x = layer.x * imageWidth;
        const y = layer.y * imageHeight + (i - (lines.length - 1) / 2) * layer.fontSize * layer.lineHeight;
        if (layer.strokeWidth > 0) ctx.strokeText(line, x, y);
        ctx.fillText(line, x, y);
      });
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
    if (!canvas || !hasPaint) return;
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
      historyRef.current = [blob];
      histIndex.current = 0;
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
        <span className="ml-auto flex gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => void fromPins()}>
            从标号生成文字层
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void autoInpaint()}>
            自动去字
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => void undo()}>
            撤销
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
          <p className="text-[11px] text-ink-400">原图层已锁定。橡皮只擦涂改层。仿制：Alt 取源后涂抹。</p>
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
                  className={`absolute max-w-[40%] -translate-x-1/2 -translate-y-1/2 whitespace-pre-wrap text-center ${
                    selectedText === layer.id ? 'outline outline-2 outline-halo' : ''
                  }`}
                  style={{
                    left: `${layer.x * 100}%`,
                    top: `${layer.y * 100}%`,
                    color: layer.color,
                    fontSize: layer.fontSize,
                    fontWeight: layer.fontWeight,
                    WebkitTextStroke: `${layer.strokeWidth / 2}px ${layer.stroke}`,
                    lineHeight: layer.lineHeight,
                    pointerEvents: tool === 'text' ? 'auto' : 'none',
                  }}
                  onPointerDown={(event) => {
                    if (tool !== 'text') return;
                    event.stopPropagation();
                    setSelectedText(layer.id);
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
            </div>
          </div>
        </div>

        <aside className="w-64 shrink-0 rounded-xl border border-ink-700 bg-cloud/80 p-3">
          <h2 className="text-sm font-medium text-ink-100">图层</h2>
          <ul className="mt-2 space-y-1 text-xs text-ink-300">
            <li className="rounded bg-paper px-2 py-1">背景（原图，锁定）</li>
            <li className="rounded bg-paper px-2 py-1">涂改 {dirty ? '· 未保存' : ''}</li>
            <li className="rounded bg-paper px-2 py-1">文字 · {textLayers.length}</li>
          </ul>
          {selected && (
            <div className="mt-3 space-y-2">
              <textarea
                className="input min-h-[80px] text-xs"
                value={selected.text}
                onChange={(e) => {
                  setTextLayers((prev) =>
                    prev.map((l) => (l.id === selected.id ? { ...l, text: e.target.value } : l)),
                  );
                  setDirty(true);
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
                    setTextLayers((prev) =>
                      prev.map((l) => (l.id === selected.id ? { ...l, fontSize } : l)),
                    );
                    setDirty(true);
                  }}
                  className="w-full accent-sky"
                />
              </label>
              <button
                type="button"
                className="btn-danger w-full py-1 text-xs"
                onClick={() => {
                  setTextLayers((prev) => prev.filter((l) => l.id !== selected.id));
                  setSelectedText(null);
                  setDirty(true);
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
