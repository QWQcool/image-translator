'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { originalUrl } from '@/lib/media';
import type { Annotation, Space, SpaceItem } from '@/lib/types';

/**
 * 空间阅读模式：全屏翻页阅读器。
 * - 翻页：←/→、空格、滚轮、点击左右半屏
 * - 设置（右上角，localStorage 全局持久化）：纵向/横向分页、正序/倒序、适应宽度/适应屏幕、显示译文
 * - 记住上次读到的序号（localStorage，按空间存）
 * - 译文叠加：读取标注，按标注样式（颜色/底色/字号比例/对齐/粗细）以 DOM 覆盖，不做涂改层合成
 */

type ReaderSettings = {
  /** 纵向分页（一次一张）/ 横向分页（一次两张对页） */
  mode: 'vertical' | 'horizontal';
  /** 正序 / 倒序（倒序=漫画从后往前，翻页键与排序都反转） */
  direction: 'asc' | 'desc';
  /** 适应宽度 / 适应屏幕 */
  fit: 'width' | 'screen';
  /** 显示译文 */
  showText: boolean;
};

const DEFAULT_SETTINGS: ReaderSettings = {
  mode: 'vertical',
  direction: 'asc',
  fit: 'width',
  showText: true,
};

const SETTINGS_KEY = 'reader-settings-v1';
const posKey = (spaceId: number) => `reader-pos-space-${spaceId}`;

function loadSettings(): ReaderSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      mode: parsed.mode === 'horizontal' ? 'horizontal' : 'vertical',
      direction: parsed.direction === 'desc' ? 'desc' : 'asc',
      fit: parsed.fit === 'screen' ? 'screen' : 'width',
      showText: parsed.showText !== false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function ReaderClient({ spaceId }: { spaceId: number }) {
  const router = useRouter();
  const [space, setSpace] = useState<Space | null>(null);
  const [items, setItems] = useState<SpaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 当前图片下标（按「显示顺序」计；与分页模式解耦，切换单/双页时位置不漂移）
  const [imgIndex, setImgIndex] = useState<number | null>(null);
  const [annotationsByItem, setAnnotationsByItem] = useState<Record<number, Annotation[]>>({});
  const [naturalSizes, setNaturalSizes] = useState<Record<number, { w: number; h: number }>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const wheelLock = useRef(false);
  const restored = useRef(false);

  // 加载空间与条目（阅读模式人人可用，与详情页同一接口）
  useEffect(() => {
    setSettings(loadSettings());
    void (async () => {
      try {
        const res = await fetch(`/api/spaces/${spaceId}`);
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        if (!res.ok) {
          router.replace('/spaces');
          return;
        }
        const data = await res.json();
        setSpace(data.space ?? null);
        setItems(Array.isArray(data.items) ? data.items : []);
      } finally {
        setLoading(false);
      }
    })();
  }, [spaceId, router]);

  // 恢复上次读到的序号（按空间存）
  useEffect(() => {
    if (restored.current || items.length === 0) return;
    restored.current = true;
    const saved = Number(window.localStorage.getItem(posKey(spaceId)));
    setImgIndex(Number.isInteger(saved) ? Math.min(Math.max(saved, 0), items.length - 1) : 0);
  }, [items, spaceId]);

  // 显示顺序：倒序时反转（翻页键语义随之反转：→ 永远沿阅读顺序前进）
  const ordered = useMemo(
    () => (settings.direction === 'desc' ? [...items].reverse() : items),
    [items, settings.direction],
  );

  const chunk = settings.mode === 'horizontal' ? 2 : 1;
  // 当前页的图片（横向模式两张为一组）
  const pageItems = useMemo(() => {
    if (imgIndex === null || ordered.length === 0) return [];
    const start = Math.min(Math.floor(imgIndex / chunk) * chunk, ordered.length - 1);
    return ordered.slice(start, start + chunk);
  }, [imgIndex, ordered, chunk]);

  const flip = useCallback(
    (delta: number) => {
      setImgIndex((prev) => {
        if (prev === null || ordered.length === 0) return prev;
        const next = prev + delta * chunk;
        return Math.min(Math.max(next, 0), ordered.length - 1);
      });
      // 翻页后回到页面顶部；加锁避免触控板惯性连翻
      wheelLock.current = true;
      window.setTimeout(() => {
        wheelLock.current = false;
      }, 400);
    },
    [ordered.length, chunk],
  );

  // 翻页后滚动位置复位
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [imgIndex]);

  // 序号持久化（按空间）
  useEffect(() => {
    if (imgIndex === null) return;
    window.localStorage.setItem(posKey(spaceId), String(imgIndex));
  }, [imgIndex, spaceId]);

  // 键盘：←/→、空格翻页，Esc 退出
  useEffect(() => {
    if (imgIndex === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        router.push(`/spaces/${spaceId}`);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (settingsOpen || target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return;
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        flip(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        flip(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [imgIndex, settingsOpen, flip, router, spaceId]);

  // 滚轮翻页：适应宽度下页面超高时先滚到底/顶，再翻页
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || imgIndex === null) return;
    const onWheel = (event: WheelEvent) => {
      if (settingsOpen) return;
      const forward = event.deltaY > 0 || event.deltaX > 0;
      const delta = forward ? 1 : -1;
      const scrollable = el.scrollHeight > el.clientHeight + 4;
      // 还能继续滚动就不拦截，交给浏览器原生滚动
      if (scrollable && forward && el.scrollTop + el.clientHeight < el.scrollHeight - 4) return;
      if (scrollable && !forward && el.scrollTop > 4) return;
      event.preventDefault();
      if (wheelLock.current) return;
      flip(delta);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [imgIndex, settingsOpen, flip]);

  // 点击左右半屏翻页（中间 10% 不响应，减少误触）
  const onSurfaceClick = useCallback(
    (event: React.MouseEvent) => {
      if (settingsOpen || imgIndex === null || ordered.length === 0) return;
      const ratio = event.clientX / window.innerWidth;
      if (ratio < 0.45) flip(-1);
      else if (ratio > 0.55) flip(1);
    },
    [settingsOpen, imgIndex, ordered.length, flip],
  );

  // 显示译文开启时，按需拉取当前页条目的标注
  useEffect(() => {
    if (!settings.showText || imgIndex === null) return;
    for (const item of pageItems) {
      if ((item.annotation_count ?? 0) === 0) continue;
      setAnnotationsByItem((prev) => {
        if (prev[item.id]) return prev; // 已缓存或请求中
        void (async () => {
          try {
            const res = await fetch(`/api/items/${item.id}/annotations`);
            if (!res.ok) return;
            const data = await res.json();
            setAnnotationsByItem((cur) => ({
              ...cur,
              [item.id]: Array.isArray(data.annotations) ? data.annotations : [],
            }));
          } catch {
            // 网络失败不阻塞阅读，下次翻回再试
          }
        })();
        return { ...prev, [item.id]: [] }; // 占位防重复请求
      });
    }
  }, [settings.showText, imgIndex, pageItems]);

  function updateSettings(patch: Partial<ReaderSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  function rememberNatural(itemId: number, w: number, h: number) {
    if (!w || !h) return;
    setNaturalSizes((prev) => (prev[itemId]?.w === w ? prev : { ...prev, [itemId]: { w, h } }));
  }

  const total = ordered.length;
  const firstNo = imgIndex === null ? 0 : Math.min(imgIndex + 1, total);
  const lastNo = firstNo + pageItems.length - 1;
  const progress =
    total === 0 ? '0 / 0' : pageItems.length > 1 ? `${firstNo}-${lastNo} / ${total}` : `${firstNo} / ${total}`;
  const canPrev = imgIndex !== null && imgIndex > 0;
  const canNext = imgIndex !== null && imgIndex + chunk < total;

  if (loading && !space) {
    return <div className="fixed inset-0 z-50 grid place-items-center bg-ink-950 text-sm text-ink-400">加载中…</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex select-none flex-col bg-ink-950 text-ink-100">
      {/* 顶部工具条 */}
      <div
        className="pointer-events-auto absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => router.push(`/spaces/${spaceId}`)}>
          ← 退出阅读
        </button>
        <span className="min-w-0 truncate text-xs text-ink-400">{space?.name ?? ''}</span>
        <button
          type="button"
          className="btn-ghost ml-auto px-2.5 py-1 text-xs"
          onClick={() => setSettingsOpen((v) => !v)}
        >
          ⚙ 设置
        </button>
      </div>

      {/* 设置面板 */}
      {settingsOpen && (
        <div
          className="absolute right-4 top-14 z-30 w-64 space-y-3 rounded-xl border border-white/10 bg-ink-900/95 p-4 text-xs shadow-2xl backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="font-medium text-ink-200">阅读设置</p>
          <label className="flex items-center justify-between gap-2">
            <span className="text-ink-400">浏览模式</span>
            <select
              className="input px-2 py-1 text-xs"
              value={settings.mode}
              onChange={(e) => updateSettings({ mode: e.target.value as ReaderSettings['mode'] })}
            >
              <option value="vertical">纵向分页</option>
              <option value="horizontal">横向分页（对页）</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-ink-400">阅读方向</span>
            <select
              className="input px-2 py-1 text-xs"
              value={settings.direction}
              onChange={(e) => updateSettings({ direction: e.target.value as ReaderSettings['direction'] })}
            >
              <option value="asc">正序</option>
              <option value="desc">倒序（漫画）</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-ink-400">适应方式</span>
            <select
              className="input px-2 py-1 text-xs"
              value={settings.fit}
              onChange={(e) => updateSettings({ fit: e.target.value as ReaderSettings['fit'] })}
            >
              <option value="width">适应宽度</option>
              <option value="screen">适应屏幕</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-ink-400">显示译文</span>
            <input
              type="checkbox"
              checked={settings.showText}
              onChange={(e) => updateSettings({ showText: e.target.checked })}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-ink-500">
            翻页：← / → / 空格 / 滚轮 / 点击左右半屏；Esc 退出。
          </p>
        </div>
      )}

      {/* 阅读区 */}
      {total === 0 ? (
        <div className="grid flex-1 place-items-center text-sm text-ink-400">
          <div className="text-center">
            <p>这个空间还没有图片</p>
            <button type="button" className="btn-primary mt-4" onClick={() => router.push(`/spaces/${spaceId}`)}>
              返回空间
            </button>
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-x-hidden overflow-y-auto" onClick={onSurfaceClick}>
          <div className="flex min-h-full items-center justify-center px-2 py-16">
            <div className={chunk === 2 ? 'flex w-full items-center justify-center gap-1' : 'w-full'}>
              {pageItems.map((item) => (
                <PageImage
                  key={item.id}
                  item={item}
                  settings={settings}
                  annotations={settings.showText ? (annotationsByItem[item.id] ?? null) : null}
                  natural={naturalSizes[item.id] ?? null}
                  onNatural={rememberNatural}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 底部序号与翻页按钮 */}
      {total > 0 && (
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex items-center justify-center gap-4 bg-gradient-to-t from-black/70 to-transparent px-4 py-3"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="btn-ghost px-3 py-1 text-xs disabled:opacity-30"
            disabled={!canPrev}
            onClick={() => flip(-1)}
          >
            ‹ 上一页
          </button>
          <span className="min-w-20 text-center text-xs tabular-nums text-ink-300">{progress}</span>
          <button
            type="button"
            className="btn-ghost px-3 py-1 text-xs disabled:opacity-30"
            disabled={!canNext}
            onClick={() => flip(1)}
          >
            下一页 ›
          </button>
        </div>
      )}
    </div>
  );
}

/** 单页图片 + 译文叠加层 */
function PageImage({
  item,
  settings,
  annotations,
  natural,
  onNatural,
}: {
  item: SpaceItem;
  settings: ReaderSettings;
  annotations: Annotation[] | null;
  natural: { w: number; h: number } | null;
  onNatural: (itemId: number, w: number, h: number) => void;
}) {
  const asset = item.asset;
  if (!asset) return null;
  const fitWidth = settings.fit === 'width';

  // 宽高比：优先取实际加载尺寸，退回素材登记尺寸
  const aspect =
    natural && natural.w > 0 && natural.h > 0
      ? natural.w / natural.h
      : asset.width && asset.height
        ? asset.width / asset.height
        : 0.75;

  return (
    <div className={chunkClass(settings.mode, fitWidth)}>
      <div className="relative mx-auto" style={{ containerType: 'inline-size' } as React.CSSProperties}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={originalUrl(asset.filename)}
          alt={item.title ?? ''}
          draggable={false}
          onLoad={(e) => onNatural(item.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          className={
            fitWidth
              ? 'block h-auto w-full'
              : 'mx-auto block max-h-[calc(100vh-8rem)] w-auto max-w-full'
          }
        />
        {annotations && annotations.length > 0 && (
          <TextOverlay annotations={annotations} aspect={aspect} />
        )}
      </div>
    </div>
  );
}

function chunkClass(mode: ReaderSettings['mode'], fitWidth: boolean): string {
  if (mode === 'horizontal') {
    return fitWidth ? 'w-1/2 min-w-0' : 'flex-1 min-w-0';
  }
  return fitWidth ? 'w-full' : 'flex justify-center';
}

/**
 * 译文叠加层：按标注样式渲染译文。
 * 字号 = font_size_ratio × 图片高度。容器高度 = 容器宽度 / 宽高比，
 * 因此用 `calc(ratio*100cqw / aspect)` 以容器查询单位表达，无需测量像素。
 */
function TextOverlay({ annotations, aspect }: { annotations: Annotation[]; aspect: number }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      {annotations
        .filter((a) => a.text.trim().length > 0)
        .map((a) => (
          <div
            key={a.id}
            className="absolute"
            style={{
              left: `${a.x * 100}%`,
              top: `${a.y * 100}%`,
              width: a.kind === 'box' ? `${Math.max(a.w, 0.01) * 100}%` : undefined,
              maxWidth: '100%',
              fontSize: `calc(${(a.font_size_ratio * 100).toFixed(4)}cqw / ${aspect.toFixed(6)})`,
              color: a.color,
              background: a.bg_color,
              textAlign: a.align,
              fontWeight: a.font_weight,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.25,
            } as React.CSSProperties}
          >
            {a.text}
          </div>
        ))}
    </div>
  );
}
