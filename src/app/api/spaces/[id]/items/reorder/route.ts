import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

/**
 * 空间内图片排序：客户端把完整条目 id 顺序发上来，服务端重写 sort_order。
 * 未出现在列表里的条目（理论上不会有）追加在末尾，保持原有相对顺序。
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'edit');
  if (denied) return denied;

  let body: { order?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const order = [...new Set((body.order ?? []).filter((id) => Number.isInteger(id)))];
  if (order.length === 0) {
    return NextResponse.json({ error: '没有需要排序的条目' }, { status: 400 });
  }

  // 校验：所有 id 必须属于该空间，防止借排序接口改动别的空间
  const placeholders = order.map(() => '?').join(',');
  const owned = db
    .prepare(
      `SELECT id FROM space_items WHERE space_id = ? AND id IN (${placeholders})`,
    )
    .all(spaceId, ...order) as Array<{ id: number }>;
  const ownedIds = new Set(owned.map((row) => row.id));
  const sequence = order.filter((id) => ownedIds.has(id));
  if (sequence.length === 0) {
    return NextResponse.json({ error: '条目不属于该空间' }, { status: 400 });
  }

  // 未列出的条目按原顺序排在后面
  const rest = db
    .prepare(
      `SELECT id FROM space_items
        WHERE space_id = ? AND id NOT IN (${placeholders})
        ORDER BY sort_order, id`,
    )
    .all(spaceId, ...sequence) as Array<{ id: number }>;
  const fullSequence = [...sequence, ...rest.map((row) => row.id)];

  const update = db.prepare('UPDATE space_items SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    fullSequence.forEach((id, index) => update.run(index + 1, id));
    db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(spaceId);
  })();

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(spaceId) as
    | { name: string }
    | undefined;
  logOp(
    user.id,
    'sort',
    'space',
    spaceId,
    space?.name ?? `空间 ${spaceId}`,
    `调整空间内图片顺序（${sequence.length} 张）`,
  );

  const items = db
    .prepare('SELECT * FROM space_items WHERE space_id = ? ORDER BY sort_order, id')
    .all(spaceId);

  return NextResponse.json({ ok: true, items });
}
