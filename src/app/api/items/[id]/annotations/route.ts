import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { Annotation } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(itemId) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'view');
  if (denied) return denied;

  const annotations = db
    .prepare('SELECT * FROM annotations WHERE item_id = ? ORDER BY order_index, id')
    .all(itemId) as Annotation[];

  return NextResponse.json({ annotations });
}

type IncomingAnnotation = {
  id?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font_size_ratio: number;
  color: string;
  bg_color: string;
  align: 'left' | 'center' | 'right';
  font_weight: number;
};

const ALIGNS = new Set(['left', 'center', 'right']);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 全量保存：客户端把编辑器当前的全部标注一次性提交，服务端在事务内整体替换 */
export async function PUT(request: Request, { params }: Params) {
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
  if (denied) return denied;
  if (!item) return NextResponse.json({ error: '条目不存在' }, { status: 404 });
  const owned = item;

  let body: { annotations?: IncomingAnnotation[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const incoming = body.annotations ?? [];
  if (!Array.isArray(incoming)) {
    return NextResponse.json({ error: 'annotations 必须是数组' }, { status: 400 });
  }

  const normalized = incoming.map((item, index) => {
    const x = clamp01(item.x);
    const y = clamp01(item.y);
    return {
      id: Number.isInteger(item.id) ? Number(item.id) : null,
      x,
      y,
      // 保证框不越界
      w: Math.max(0, Math.min(1 - x, clamp01(item.w))),
      h: Math.max(0, Math.min(1 - y, clamp01(item.h))),
      text: String(item.text ?? ''),
      font_size_ratio: Math.min(0.5, Math.max(0.004, Number(item.font_size_ratio) || 0.035)),
      color: /^#[0-9a-fA-F]{6}$/.test(item.color ?? '') ? item.color : '#FFFFFF',
      bg_color: /^#[0-9a-fA-F]{8}$|^#[0-9a-fA-F]{6}$/.test(item.bg_color ?? '')
        ? item.bg_color
        : '#000000B3',
      align: ALIGNS.has(item.align) ? item.align : 'left',
      font_weight: item.font_weight === 400 ? 400 : 700,
      order_index: index,
    };
  });

  const clear = db.prepare('DELETE FROM annotations WHERE item_id = ?');
  const insert = db.prepare(
    `INSERT INTO annotations
       (item_id, x, y, w, h, text, font_size_ratio, color, bg_color, align, font_weight, order_index)
     VALUES (@item_id, @x, @y, @w, @h, @text, @font_size_ratio, @color, @bg_color, @align, @font_weight, @order_index)`,
  );
  const touch = db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`);

  db.transaction(() => {
    clear.run(itemId);
    for (const row of normalized) {
      insert.run({ ...row, item_id: itemId });
    }
    touch.run(owned.space_id);
  })();

  const annotations = db
    .prepare('SELECT * FROM annotations WHERE item_id = ? ORDER BY order_index, id')
    .all(itemId) as Annotation[];

  return NextResponse.json({ annotations });
}
