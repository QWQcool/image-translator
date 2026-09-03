import { NextResponse } from 'next/server';
import { adminForbidden, getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';

type Params = { params: Promise<{ id: string }> };

/** 作废邀请码（仅管理员，且仅未使用的码可删） */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  const denied = adminForbidden(user);
  if (denied) return denied;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const row = db
    .prepare('SELECT id, code, used_by FROM invite_codes WHERE id = ?')
    .get(id) as { id: number; code: string; used_by: number | null } | undefined;
  if (!row) return NextResponse.json({ error: '邀请码不存在' }, { status: 404 });
  if (row.used_by !== null) {
    return NextResponse.json({ error: '该邀请码已被使用，无法作废' }, { status: 400 });
  }

  db.prepare('DELETE FROM invite_codes WHERE id = ?').run(id);
  logOp(user.id, 'invite_delete', 'invite', id, row.code, '作废邀请码');

  return NextResponse.json({ ok: true });
}
