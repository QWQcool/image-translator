import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** 按用户名搜索，用于向空间添加成员。不暴露邮箱等敏感字段。 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (keyword.length === 0) return NextResponse.json({ users: [] });

  const users = db
    .prepare(
      `SELECT id, username FROM users
        WHERE username LIKE ? AND id != ?
        ORDER BY username LIMIT 10`,
    )
    .all(`%${keyword}%`, user.id) as Array<{ id: number; username: string }>;

  return NextResponse.json({ users });
}
