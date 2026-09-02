import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { saveGuard } from '@/lib/room';

type Params = { params: Promise<{ id: string }> };

/**
 * AI 翻译采纳：把译文直接写入对应标号的 text 字段。
 * 单张图的翻译走前端弹层 + 标注保存（PUT /annotations）即可；
 * 这个接口主要给「AI 批量处理」用（无人值守地串行写入）。
 */
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

  // 协作锁：别人持锁且未共享时不允许覆盖
  const guard = saveGuard(itemId, user.id);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: 423 });
  }

  let body: { translations?: Array<{ id?: number; text?: string }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const incoming = (body.translations ?? []).filter(
    (row) => Number.isInteger(row.id) && typeof row.text === 'string',
  );
  if (incoming.length === 0) {
    return NextResponse.json({ error: '没有要写入的译文' }, { status: 400 });
  }

  const update = db.prepare(
    `UPDATE annotations SET text = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ? AND item_id = ? AND kind = 'pin'`,
  );
  const touch = db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`);

  let changed = 0;
  db.transaction(() => {
    for (const row of incoming) {
      const result = update.run(String(row.text).slice(0, 2000), user.id, row.id, itemId);
      changed += result.changes;
    }
    touch.run(item.space_id);
  })();

  logOp(
    user.id,
    'update',
    'item',
    itemId,
    itemDisplayName(itemId),
    `AI 翻译写入 ${changed} 条译文`,
  );

  return NextResponse.json({ ok: true, changed });
}
