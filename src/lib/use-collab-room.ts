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
/** SSE 停滞判定：超过这个时间没有任何事件（含 ping 心跳）就降级轮询 */
const SSE_STALL_MS = 5_000;
/** SSE 降级后自动重试的间隔 */
const SSE_RETRY_MS = 15_000;

/**
 * 协作房间客户端：进编辑页即接管/续期锁，实时通道优先 SSE（/stream，笔画级延迟），
 * SSE 失败或 5 秒无心跳自动降级回 1.2s 轮询，SSE 恢复后再自动切回。
 * 两条通道共用同一个 since 游标，切换不会丢操作也不会重复回放。
 */
export function useCollabRoom(itemId: number) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [me, setMe] = useState<number | null>(null);
  const [activeAuthors, setActiveAuthors] = useState<Map<number, number>>(new Map());
  /** 当前是否走 SSE 推送（false = 轮询模式） */
  const [sseActive, setSseActive] = useState(false);

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

  // 实时通道：SSE 优先（300ms 推送），失败/停滞降级 1.2s 轮询，恢复后自动切回
  useEffect(() => {
    if (!itemId) return;
    let stopped = false;
    let es: EventSource | null = null;
    let pollTimer = 0;
    let watchdog = 0;
    let retryTimer = 0;
    let lastActivity = Date.now();

    /** 处理一条远端操作（SSE 与轮询共用，游标与"正在参与"逻辑也共用） */
    const handleOp = (op: CollabOp) => {
      sinceRef.current = Math.max(sinceRef.current, op.seq);
      const authors = new Map(activeAuthorsRef.current);
      authors.set(op.authorId, Date.now());
      // 30s 没动静的作者从"正在参与"里淡出
      for (const [id, at] of authors) {
        if (Date.now() - at > 30_000) authors.delete(id);
      }
      activeAuthorsRef.current = authors;
      setActiveAuthors(authors);
      if (op.kind === 'meta') return; // 锁状态已经在 room 里
      if (me !== null && op.authorId === me) return; // 自己的操作不回放
      onOpRef.current(op);
    };

    const startPolling = () => {
      if (pollTimer || stopped) return;
      const poll = async () => {
        pollTimer = 0;
        try {
          const res = await fetch(`/api/items/${itemId}/room?since=${sinceRef.current}`);
          if (res.ok && !stopped) {
            const data = (await res.json()) as { room: RoomState; ops: CollabOp[] };
            setRoom(data.room);
            for (const op of data.ops ?? []) handleOp(op);
          }
        } catch {
          // 忽略单次失败
        }
        if (!stopped && !pollTimer) pollTimer = window.setTimeout(() => void poll(), POLL_MS);
      };
      pollTimer = window.setTimeout(() => void poll(), POLL_MS);
    };

    const stopPolling = () => {
      if (pollTimer) {
        window.clearTimeout(pollTimer);
        pollTimer = 0;
      }
    };

    const closeSse = () => {
      if (es) {
        es.close();
        es = null;
      }
    };

    /** 降级：关掉 SSE、开轮询，稍后自动重试 SSE（重试成功会重新停掉轮询） */
    const degrade = () => {
      closeSse();
      setSseActive(false);
      startPolling();
      if (!stopped && !retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = 0;
          connectSse();
        }, SSE_RETRY_MS);
      }
    };

    const connectSse = () => {
      if (stopped || es) return;
      lastActivity = Date.now();
      const source = new EventSource(`/api/items/${itemId}/stream?since=${sinceRef.current}`);
      es = source;
      source.onopen = () => {
        lastActivity = Date.now();
        // 连接成功：停掉轮询，切到 SSE 推送
        stopPolling();
        setSseActive(true);
      };
      source.addEventListener('op', (event) => {
        lastActivity = Date.now();
        try {
          handleOp(JSON.parse((event as MessageEvent).data) as CollabOp);
        } catch {
          // 忽略坏帧
        }
      });
      source.addEventListener('room', (event) => {
        lastActivity = Date.now();
        try {
          setRoom(JSON.parse((event as MessageEvent).data) as RoomState);
        } catch {
          // 忽略坏帧
        }
      });
      source.addEventListener('ping', () => {
        lastActivity = Date.now();
      });
      source.addEventListener('bye', () => {
        // 服务端关流（房间销毁/锁过期）：降级轮询，等房间重建后重试 SSE
        degrade();
      });
      source.onerror = () => {
        // 连接失败/中断：EventSource 会自己重连，但我们主动接管——降级轮询 + 定时重试
        degrade();
      };
    };

    // 停滞看门狗：SSE 连着但 5 秒没有任何事件（网络半死）→ 主动降级
    watchdog = window.setInterval(() => {
      if (es && Date.now() - lastActivity > SSE_STALL_MS) {
        degrade();
      }
    }, 1_000);

    connectSse();

    return () => {
      stopped = true;
      closeSse();
      stopPolling();
      if (watchdog) window.clearInterval(watchdog);
      if (retryTimer) window.clearTimeout(retryTimer);
      setSseActive(false);
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

  return { room, me, activeAuthors, sseActive, onRemoteOp, sendOp, setShared, release };
}