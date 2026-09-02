import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { Annotation } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

type Incoming = { x: number; y: number; source_text?: string; group_id?: number };

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(itemId) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  let body: { proposals?: Incoming[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const incoming = (body.proposals ?? []).filter(
    (row) => Number.isFinite(row.x) && Number.isFinite(row.y),
  );
  if (incoming.length === 0) {
    return NextResponse.json({ error: '没有要采纳的标号' }, { status: 400 });
  }

  const maxOrder = db
    .prepare(`SELECT COALESCE(MAX(order_index), -1) AS m FROM annotations WHERE item_id = ?`)
    .get(itemId) as { m: number };
  const insert = db.prepare(
    `INSERT INTO annotations
       (item_id, x, y, w, h, text, font_size_ratio, color, bg_color, align, font_weight,
        order_index, kind, group_id, source_text, comment, updated_by)
     VALUES (?, ?, ?, 0, 0, '', 0.035, '#FFFFFF', '#000000B3', 'left', 700,
        ?, 'pin', ?, ?, '', ?)`,
  );

  db.transaction(() => {
    incoming.forEach((row, index) => {
      const groupId = Number.isInteger(row.group_id) ? Math.min(9, Math.max(1, Number(row.group_id))) : 1;
      insert.run(
        itemId,
        Math.min(1, Math.max(0, row.x)),
        Math.min(1, Math.max(0, row.y)),
        maxOrder.m + 1 + index,
        groupId,
        String(row.source_text ?? ''),
        user.id,
      );
    });
  })();

  const annotations = db
    .prepare(
      `SELECT a.*, u.username AS updated_by_username
         FROM annotations a LEFT JOIN users u ON u.id = a.updated_by
        WHERE a.item_id = ? ORDER BY a.order_index, a.id`,
    )
    .all(itemId) as Annotation[];

  return NextResponse.json({ annotations });
}
