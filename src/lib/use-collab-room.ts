'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type RoomState = {
  itemId: number;
  holderId: number | null;
  holderName: string | null;
  shared: boolean;
  isHolder: boolean;
  canEdit: boolean;
  seq: number;
};

export type CollabOp = {
  seq: number;
  authorId: number;
  kind: string;
  payload: unknown;
};

const HEARTBEAT_MS = 15_000;
const POLL_MS = 1_200;

/**
 * 协作房间客户端：进编辑页即接管/续期锁，轮询增量操作日志。
 *
 * 设计取舍：用 1.2s 轮询而不是 WebSocket——
 * dev 模式下 WS 升级要额外进程，而 15 个连接 × 1 轮询/秒对服务器是零负担，
 * 延迟感知也在可接受范围；后续要压延迟再换 SSE/WS，接口不变。
 */
export function useCollabRoom(itemId: number) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [me, setMe] = useState<number | null>(null);
  const [activeAuthors, setActiveAuthors] = useState<Map<number, number>>(new Map());

  const sinceRef = useRef(0);
  const onOpRef = useRef<(op: CollabOp) => void>(() => {});
  const aliveRef = useRef(true);
  const activeAuthorsRef = useRef<Map<number, number>>(new Map());

  /** 注册远端操作的处理器（组件里用 ref 传进来，避免闭包过期） */
  const onRemoteOp = useCallback((fn: (op: CollabOp) => void) => {
    onOpRef.current = fn;
  }, []);

  // 我是谁（用于过滤自己发出的操作）
  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const data = await res.json();
        if (aliveRef.current) setMe(data.user?.id ?? data.id ?? null);
      } catch {
        // 未登录时 hook 不会启用
      }
    })();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 心跳：接管锁 / 续期
  useEffect(() => {
    if (!itemId) return;
    aliveRef.current = true;
    let stopped = false;

    const touch = async () => {
      try {
        const res = await fetch(`/api/items/${itemId}/room`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'touch' }),
        });
        if (res.ok && !stopped) {
          const data = await res.json();
          setRoom(data.room);
        }
      } catch {
        // 网络抖动时保持现状，下个心跳再试
      }
    };

    void touch();
    const timer = window.setInterval(() => void touch(), HEARTBEAT_MS);
    return () => {
      stopped = true;
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [itemId]);

  // 轮询增量操作
  useEffect(() => {
    if (!itemId) return;
    let stopped = false;
    let timer = 0;

    const poll = async () => {
      try {
        const res = await fetch(`/api/items/${itemId}/room?since=${sinceRef.current}`);
        if (res.ok && !stopped) {
          const data = (await res.json()) as { room: RoomState; ops: CollabOp[] };
          setRoom(data.room);
          const authors = new Map(activeAuthorsRef.current);
          for (const op of data.ops ?? []) {
            sinceRef.current = Math.max(sinceRef.current, op.seq);
            authors.set(op.authorId, Date.now());
            if (op.kind === 'meta') continue; // 锁状态已经在 room 里
            if (me !== null && op.authorId === me) continue; // 自己的操作不回放
            onOpRef.current(op);
          }
          // 30s 没动静的作者从"正在参与"里淡出
          for (const [id, at] of authors) {
            if (Date.now() - at > 30_000) authors.delete(id);
          }
          setActiveAuthors(authors);
        }
      } catch {
        // 忽略单次失败
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    };

    timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [itemId, me]);

  const sendOp = useCallback(
    async (kind: string, payload: unknown) => {
      try {
        await fetch(`/api/items/${itemId}/room`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'op', kind, payload }),
        });
      } catch {
        // 发送失败不阻塞本地编辑；下次保存会全量同步
      }
    },
    [itemId],
  );

  const setShared = useCallback(
    async (shared: boolean) => {
      try {
        const res = await fetch(`/api/items/${itemId}/room`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'share', shared }),
        });
        if (res.ok) {
          const data = await res.json();
          setRoom(data.room);
        }
      } catch {
        // 忽略
      }
    },
    [itemId],
  );

  const release = useCallback(async () => {
    try {
      await fetch(`/api/items/${itemId}/room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release' }),
      });
    } catch {
      // 锁 40s 后自动过期，无需兜底
    }
  }, [itemId]);

  return { room, me, activeAuthors, onRemoteOp, sendOp, setShared, release };
}