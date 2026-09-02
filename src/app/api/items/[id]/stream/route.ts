import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { getRoomState, readOps } from '@/lib/room';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TICK_MS = 300;
const PING_MS = 15_000;

/**
 * SSE 实时通道：持续推送该房间 seq > cursor 的新 op。
 * - 每 300ms 查一次 op 表，有新 op 就推 event: op
 * - meta 操作（锁/共享状态变化）额外推一次 event: room（完整房间状态）
 * - 每 15s 推 `: ping` 注释行防代理断连，另推一个 event: ping 供客户端做停滞检测
 * - 房间销毁/锁过期则推 event: bye 并关闭，客户端自动降级回轮询
 * 客户端（use-collab-room）在 SSE 失败或 5 秒无心跳时自动回退 1.2s 轮询，两条通道共存。
 */
export async function GET(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(id) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'view');
  if (denied) return denied;

  // 游标：客户端带上自己的 since 增量续传；不带则从当前最新开始（历史由首次轮询补齐）
  let cursor = Number(new URL(request.url).searchParams.get('since') ?? '') || 0;
  if (cursor <= 0) {
    cursor = (
      db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM room_ops WHERE item_id = ?').get(id) as {
        m: number;
      }
    ).m;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let opTimer: ReturnType<typeof setInterval> | null = null;
      let pingTimer: ReturnType<typeof setInterval> | null = null;

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false;
        }
      };
      const send = (event: string, data: unknown): boolean =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (opTimer) clearInterval(opTimer);
        if (pingTimer) clearInterval(pingTimer);
        try {
          controller.close();
        } catch {
          // 已被下游关闭
        }
      };

      // 连接时房间里有没有锁行：作为「房间销毁」的判定基准
      let hadRoom = !!db.prepare('SELECT item_id FROM edit_rooms WHERE item_id = ?').get(id);

      // 连接建立即推一次房间状态，客户端立刻拿到最新锁/共享状态
      send('room', getRoomState(id, user.id));

      opTimer = setInterval(() => {
        try {
          // 房间销毁（锁被释放/过期清理）→ 通知客户端降级
          const row = db
            .prepare('SELECT item_id, expires_at FROM edit_rooms WHERE item_id = ?')
            .get(id) as { item_id: number; expires_at: number } | undefined;
          if (hadRoom && !row) {
            send('bye', { reason: 'room-gone' });
            cleanup();
            return;
          }
          hadRoom = hadRoom || !!row;
          if (row && row.expires_at <= Date.now()) {
            send('bye', { reason: 'lock-expired' });
            cleanup();
            return;
          }

          const ops = readOps(id, cursor);
          let hasMeta = false;
          for (const op of ops) {
            cursor = Math.max(cursor, op.seq);
            if (op.kind === 'meta') hasMeta = true;
            send('op', {
              seq: op.seq,
              authorId: op.author_id,
              kind: op.kind,
              payload: JSON.parse(op.payload) as unknown,
              at: op.created_at,
            });
          }
          if (hasMeta) send('room', getRoomState(id, user.id));
        } catch {
          // 单次查询失败不断流，下个周期再试
        }
      }, TICK_MS);

      // 注释行防代理缓冲断连；命名 ping 事件给客户端做 5s 停滞检测
      pingTimer = setInterval(() => {
        if (!write(': ping\n\n')) {
          cleanup();
          return;
        }
        send('ping', { t: Date.now() });
      }, PING_MS);

      // 页面卸载/客户端断开时停止定时器
      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
