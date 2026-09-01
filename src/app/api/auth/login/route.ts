import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createSession, verifyPassword } from '@/lib/auth';

export async function POST(request: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';
  if (!username || !password) {
    return NextResponse.json({ error: '请输入用户名和密码' }, { status: 400 });
  }

  const row = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string } | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
  }

  await createSession(row.id);
  return NextResponse.json({ id: row.id, username: row.username });
}
