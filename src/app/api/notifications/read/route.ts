import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/**
 * 标记通知已读：body { all: true } 全部已读，或 { ids: number[] } 指定条目。
 * 只能操作自己的通知。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { all?: boolean; ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  if (body.all === true) {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(user.id);
    return NextResponse.json({ ok: true });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is number => Number.isInteger(id) && Number(id) > 0).map(Number)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: '没有需要标记的通知' }, { status: 400 });
  }

  // 逐条置已读（只动自己的），数量有限不必拼 IN 占位符
  const mark = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?');
  db.transaction(() => {
    for (const id of ids) mark.run(id, user.id);
  })();

  return NextResponse.json({ ok: true });
}
