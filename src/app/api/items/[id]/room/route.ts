import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  appendOp,
  getRoomState,
  readOps,
  releaseRoom,
  setShared,
  touchRoom,
} from '@/lib/room';

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 房间状态 + 增量操作日志（客户端用 since 做游标轮询） */
export async function GET(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const since = Number(new URL(request.url).searchParams.get('since') ?? 0) || 0;
  const state = getRoomState(id, user.id);
  const ops = readOps(id, since).map((row) => ({
    seq: row.seq,
    authorId: row.author_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    at: row.created_at,
  }));

  return NextResponse.json({ room: state, ops });
}

/**
 * 房间动作：
 *  - touch    进入编辑页/心跳（没有锁就接管，持锁就续期）
 *  - share    持有人开/关共享
 *  - release  持有人主动释放锁
 *  - op       追加一条协作操作（笔画 / 文字层快照 / 标注快照）
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  let body: {
    action?: string;
    shared?: boolean;
    kind?: string;
    payload?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  switch (body.action) {
    case 'touch':
      return NextResponse.json({ room: touchRoom(id, user.id) });

    case 'share': {
      const state = setShared(id, user.id, body.shared === true);
      if (!state) {
        return NextResponse.json(
          { error: '只有房间持有人能开关共享' },
          { status: 403 },
        );
      }
      return NextResponse.json({ room: state });
    }

    case 'release': {
      releaseRoom(id, user.id);
      return NextResponse.json({ room: getRoomState(id, user.id) });
    }

    case 'op': {
      // 只有持有人或共享开启后才能往房间里写操作
      const state = getRoomState(id, user.id);
      if (!state.canEdit) {
        return NextResponse.json(
          { error: `${state.holderName ?? '他人'} 正在编辑，房间未共享` },
          { status: 423 },
        );
      }
      const kind = String(body.kind ?? '');
      if (!['paint', 'text', 'annotations', 'cursor'].includes(kind)) {
        return NextResponse.json({ error: '未知的操作类型' }, { status: 400 });
      }
      const seq = appendOp(id, user.id, kind, body.payload);
      return NextResponse.json({ seq });
    }

    default:
      return NextResponse.json({ error: '未知动作' }, { status: 400 });
  }
}
