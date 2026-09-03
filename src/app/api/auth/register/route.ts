import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  createSession,
  hashPassword,
  validatePassword,
  validateUsername,
} from '@/lib/auth';
import {
  checkInviteCode,
  clientIp,
  consumeInviteCode,
  consumeRegisterAttempt,
} from '@/lib/register-guard';

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

  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return NextResponse.json({ error: '该用户名已被注册' }, { status: 409 });

  // 邀请码校验 + 建用户 + 消费表码必须在同一事务内：
  // 校验通过但消费时码已被并发注册抢用会抛错，整个事务回滚，不会出现「码用了一半」。
  let inviteError: string | null = null;
  let createResult: number | null = null;
  try {
    createResult = db.transaction((): number | null => {
      const invite = checkInviteCode(body.inviteCode);
      if (!invite.ok) {
        inviteError = invite.error;
        return null;
      }

      const result = db
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, hashPassword(password));
      const newUserId = Number(result.lastInsertRowid);

      if (invite.mode === 'table') {
        consumeInviteCode(invite.tableCodeId, newUserId);
      }
      return newUserId;
    })();
  } catch {
    return NextResponse.json({ error: '邀请码无效' }, { status: 400 });
  }

  if (createResult === null) {
    return NextResponse.json({ error: inviteError ?? '邀请码无效' }, { status: 400 });
  }

  const userId = createResult;
  await createSession(userId);

  return NextResponse.json({ id: userId, username });
}
