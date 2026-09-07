import { NextResponse } from 'next/server';
import { getCurrentUser, hashPassword, validatePassword, verifyPassword } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';

/**
 * 修改密码（登录态）：需验证当前密码，防止会话被劫持后直接改密。
 * 忘记密码走管理员 CLI：`npm run admin -- passwd <用户名> [新密码]`。
 */
export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const current = String(body.currentPassword ?? '');
  const next = String(body.newPassword ?? '');
  if (!current || !next) {
    return NextResponse.json({ error: '请填写当前密码与新密码' }, { status: 400 });
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(current, row.password_hash)) {
    return NextResponse.json({ error: '当前密码不正确' }, { status: 400 });
  }

  const invalid = validatePassword(next);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  logOp(user.id, 'update', 'user', user.id, user.username, '修改密码');

  return NextResponse.json({ ok: true });
}
