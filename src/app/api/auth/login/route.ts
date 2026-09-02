import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createSession, verifyPassword } from '@/lib/auth';
import { clientIp, consumeRateLimit, isRateLimited, resetRateLimit } from '@/lib/register-guard';

/** 同一 IP 一小时内允许的登录失败次数，可用环境变量调整 */
const LOGIN_MAX_FAILS = Math.max(
  1,
  Math.trunc(Number(process.env.LOGIN_MAX_FAILS)) || 5,
);
const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000;

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

  const ip = clientIp(request);
  const failKey = `login:fail:${ip}`;

  // 已达失败上限：直接拒绝，不再比对密码
  if (isRateLimited(failKey, LOGIN_MAX_FAILS, LOGIN_FAIL_WINDOW_MS)) {
    return NextResponse.json(
      { error: '登录失败次数过多，请一小时后再试' },
      { status: 429 },
    );
  }

  const row = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string } | undefined;

  if (!row || !verifyPassword(password, row.password_hash)) {
    // 记录一次失败
    consumeRateLimit(failKey, LOGIN_MAX_FAILS, LOGIN_FAIL_WINDOW_MS);
    return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
  }

  // 登录成功：清零该 IP 的失败计数
  resetRateLimit(failKey);

  await createSession(row.id);
  return NextResponse.json({ id: row.id, username: row.username });
}
