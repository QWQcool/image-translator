import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  createSession,
  hashPassword,
  validatePassword,
  validateUsername,
} from '@/lib/auth';
import { clientIp, consumeRegisterAttempt, verifyInviteCode } from '@/lib/register-guard';

export async function POST(request: Request) {
  const ip = clientIp(request);
  const gate = consumeRegisterAttempt(ip);
  if (!gate.ok) {
    return NextResponse.json(
      { error: '注册尝试过于频繁，请稍后再试' },
      { status: 429, headers: { 'Retry-After': String(gate.retryAfterSec) } },
    );
  }

  let body: { username?: string; password?: string; inviteCode?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const username = (body.username ?? '').trim();
  const password = body.password ?? '';

  const usernameError = validateUsername(username);
  if (usernameError) return NextResponse.json({ error: usernameError }, { status: 400 });
  const passwordError = validatePassword(password);
  if (passwordError) return NextResponse.json({ error: passwordError }, { status: 400 });

  const invite = verifyInviteCode(body.inviteCode);
  if (!invite.ok) return NextResponse.json({ error: invite.error }, { status: 400 });

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return NextResponse.json({ error: '该用户名已被注册' }, { status: 409 });

  const result = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hashPassword(password));

  const userId = Number(result.lastInsertRowid);
  await createSession(userId);

  return NextResponse.json({ id: userId, username });
}
