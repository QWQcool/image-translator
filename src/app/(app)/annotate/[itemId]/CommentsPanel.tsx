'use client';

import { useCallback, useEffect, useState } from 'react';

type CommentItem = {
  id: number;
  userId: number | null;
  username: string | null;
  body: string;
  createdAt: string;
};

/** SQLite 时间戳（UTC）转本地短格式 MM-DD HH:MM */
function shortTime(raw: string): string {
  const date = new Date(raw.includes('T') ? `${raw}Z` : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const MAX_BODY_LENGTH = 500;

/**
 * 条目评论（标注编辑器侧栏底部）：view 权限即可发言，
 * 仅作者本人可删自己的评论；发表后服务端会向相关人发站内通知。
 */
export default function CommentsPanel({ itemId }: { itemId: number }) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // 当前用户 id（判断「删除」按钮只出现在自己的评论上）
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const data = await res.json();
        setCurrentUserId(Number(data.user?.id) || null);
      } catch {
        // 拿不到身份只影响删除按钮显示
      }
    })();
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/items/${itemId}/comments`);
      if (!res.ok) return;
      const data = await res.json();
      setComments(Array.isArray(data.comments) ? data.comments : []);
    } catch {
      // 拉取失败不打断标注流程
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? '评论发送失败');
        return;
      }
      setBody('');
      await load();
    } catch {
      setError('评论发送失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setError(null);
    try {
      const res = await fetch(`/api/comments/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? '删除失败');
        return;
      }
      setComments((prev) => prev.filter((row) => row.id !== id));
    } catch {
      setError('删除失败');
    }
  }

  return (
    <div className="mt-3 border-t border-ink-700 pt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-sm font-medium text-ink-100">
          评论 <span className="text-ink-500">({comments.length})</span>
        </span>
        <span className="text-[11px] text-ink-500">{expanded ? '收起 ▴' : '展开 ▾'}</span>
      </button>

      {expanded && (
        <div className="mt-2">
          {comments.length === 0 ? (
            <p className="text-[11px] text-ink-500">还没有评论，说点什么吧。</p>
          ) : (
            <ul className="max-h-44 space-y-2 overflow-y-auto pr-1">
              {comments.map((comment) => (
                <li key={comment.id} className="rounded-md border border-ink-700 px-2 py-1.5">
                  <div className="flex items-center justify-between text-[11px] text-ink-500">
                    <span className="font-medium text-ink-300">{comment.username ?? '已注销'}</span>
                    <span className="flex items-center gap-2">
                      {shortTime(comment.createdAt)}
                      {comment.userId === currentUserId && (
                        <button
                          type="button"
                          className="rounded px-1 text-blush hover:bg-blush/15"
                          onClick={() => void remove(comment.id)}
                        >
                          删除
                        </button>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-200">{comment.body}</p>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="notice-error mt-2 text-[11px]">{error}</p>}

          <textarea
            className="input mt-2 min-h-[52px] resize-y text-xs"
            placeholder="写下评论（Ctrl+Enter 发送）…"
            value={body}
            maxLength={MAX_BODY_LENGTH}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void post();
              }
              // 阻止编辑器全局快捷键吃掉输入
              e.stopPropagation();
            }}
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-ink-600">
              {body.trim().length}/{MAX_BODY_LENGTH}
            </span>
            <button
              type="button"
              className="btn-primary px-2.5 py-1 text-[11px]"
              disabled={busy || !body.trim()}
              onClick={() => void post()}
            >
              {busy ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
