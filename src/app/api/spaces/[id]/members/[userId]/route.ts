import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess, isSpaceRole } from '@/lib/permissions';

type Params = { params: Promise<{ id: string; userId: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id, userId: rawUserId } = await params;
  const spaceId = parseId(id);
  const targetUserId = parseId(rawUserId);
  if (!spaceId || !targetUserId) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'manage');
  if (denied) return denied;

  let body: { role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }
  if (!isSpaceRole(body.role)) {
    return NextResponse.json({ error: '角色不合法' }, { status: 400 });
  }

  const membership = db
    .prepare('SELECT role FROM space_members WHERE space_id = ? AND user_id = ?')
    .get(spaceId, targetUserId) as { role: string } | undefined;
  if (!membership) return NextResponse.json({ error: '该用户不是空间成员' }, { status: 404 });

  // 空间创建者始终拥有 owner 权限（权限层会回退到 spaces.owner_id），不能降级
  const space = db.prepare('SELECT owner_id FROM spaces WHERE id = ?').get(spaceId) as
    | { owner_id: number }
    | undefined;
  if (space?.owner_id === targetUserId && body.role !== 'owner') {
    return NextResponse.json({ error: '不能降级空间创建者' }, { status: 400 });
  }

  db.prepare('UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ?').run(
    body.role,
    spaceId,
    targetUserId,
  );

  const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId) as
    | { username: string }
    | undefined;
  logOp(user.id, 'member', 'member', targetUserId, targetUser?.username ?? `用户 ${targetUserId}`, `角色改为 ${body.role}`);

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { id, userId: rawUserId } = await params;
  const spaceId = parseId(id);
  const targetUserId = parseId(rawUserId);
  if (!spaceId || !targetUserId) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'manage');
  if (denied) return denied;

  const space = db.prepare('SELECT owner_id FROM spaces WHERE id = ?').get(spaceId) as
    | { owner_id: number }
    | undefined;
  if (space?.owner_id === targetUserId) {
    return NextResponse.json({ error: '不能移除空间创建者' }, { status: 400 });
  }

  const result = db
    .prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?')
    .run(spaceId, targetUserId);
  if (result.changes === 0) {
    return NextResponse.json({ error: '该用户不是空间成员' }, { status: 404 });
  }

  const targetUser = db.prepare('SELECT username FROM users WHERE id = ?').get(targetUserId) as
    | { username: string }
    | undefined;
  logOp(user.id, 'member', 'member', targetUserId, targetUser?.username ?? `用户 ${targetUserId}`, '移出空间');

  return NextResponse.json({ ok: true });
}
