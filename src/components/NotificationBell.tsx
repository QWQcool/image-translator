'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type NotificationItem = {
  id: number;
  actorName: string | null;
  itemTitle: string | null;
  body: string;
  itemId: number | null;
  spaceId: number | null;
  read: boolean;
  createdAt: string;
};

/** SQLite 时间戳（UTC）转本地短格式 MM-DD HH:MM */
function shortTime(raw: string): string {
  const date = new Date(raw.includes('T') ? `${raw}Z` : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 顶栏通知铃铛：未读数徽标（0 不显示）；下拉面板列最新 20 条，
 * 点击单条 → 标记已读并跳转对应标注页；打开时拉取，之后每 60s 轮询（页面不可见时跳过）。
 */
export default function NotificationBell() {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  /** 拉取未读数与最新列表（document.hidden 时跳过，省资源） */
  const load = useCallback(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const data = await res.json();
      setUnread(Number(data.unread) || 0);
      setItems(Array.isArray(data.items) ? data.items : []);
      setError(null);
    } catch {
      // 轮询失败不打扰用户
    }
  }, []);

  // 挂载即拉一次，之后每 60s 轮询
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // 打开面板时立即刷新
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function markRead(ids: number[]) {
    setBusy(true);
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      await load();
    } catch {
      setError('标记失败');
    } finally {
      setBusy(false);
    }
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      await load();
    } catch {
      setError('操作失败');
    } finally {
      setBusy(false);
    }
  }

  function openNotification(item: NotificationItem) {
    setOpen(false);
    if (!item.read) void markRead([item.id]);
    if (item.itemId) router.push(`/annotate/${item.itemId}`);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={`relative rounded-lg px-2 py-1.5 transition-colors ${
          open ? 'bg-sky/10 text-sky-deep' : 'text-ink-400 hover:bg-paper hover:text-ink-200'
        }`}
        title="通知"
        onClick={() => setOpen((v) => !v)}
      >
        {/* 铃铛图标（SVG，不用 emoji） */}
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="card absolute right-0 z-50 mt-2 w-80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink-100">通知</span>
            {unread > 0 && (
              <button
                type="button"
                className="btn-ghost px-2 py-0.5 text-[11px]"
                disabled={busy}
                onClick={() => void markAllRead()}
              >
                全部已读
              </button>
            )}
          </div>
          {error && <p className="notice-error mb-2 text-[11px]">{error}</p>}
          {items.length === 0 ? (
            <p className="py-4 text-center text-xs text-ink-500">还没有通知</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`block w-full rounded-md px-2 py-2 text-left text-xs ${
                      item.read ? 'text-ink-400' : 'bg-sky/5 text-ink-200'
                    } hover:bg-paper`}
                    onClick={() => openNotification(item)}
                  >
                    <span className="block truncate">
                      <strong className="font-medium">{item.actorName ?? '有人'}</strong>
                      {' '}评论了 {item.itemTitle || '一张图'}
                      {!item.read && (
                        <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-sky" />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-500" title={item.body}>
                      {item.body}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-ink-600">
                      {shortTime(item.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
