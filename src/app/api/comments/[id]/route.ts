import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

type Params = { params: Promise<{ id: string }> };

/** 删除自己的评论：仅作者本人可删（匿名/他人评论一律 403），条目不存在 404 */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const comment = db.prepare('SELECT id, user_id FROM comments WHERE id = ?').get(id) as
    | { id: number; user_id: number | null }
    | undefined;
  if (!comment) return NextResponse.json({ error: '评论不存在' }, { status: 404 });
  if (!comment.user_id || comment.user_id !== user.id) {
    return NextResponse.json({ error: '只能删除自己的评论' }, { status: 403 });
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  return NextResponse.json({ ok: true });
}
