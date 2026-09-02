import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, addMember, getSpaceAccess, isSpaceRole } from '@/lib/permissions';
import type { SpaceMember } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = parseId((await params).id);
  if (!spaceId) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'view');
  if (denied) return denied;

  const members = db
    .prepare(
      `SELECT sm.*, u.username
         FROM space_members sm
         JOIN users u ON u.id = sm.user_id
        WHERE sm.space_id = ?
        ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, sm.id`,
    )
    .all(spaceId) as SpaceMember[];

  return NextResponse.json({ members });
}

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = parseId((await params).id);
  if (!spaceId) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const access = getSpaceAccess(spaceId, user.id);
  const denied = accessError(access, 'manage');
  if (denied) return denied;

  let body: { userId?: number; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const userId = Number(body.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  if (!isSpaceRole(body.role)) {
    return NextResponse.json({ error: '角色不合法' }, { status: 400 });
  }

  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as
    | { id: number; username: string }
    | undefined;
  if (!target) return NextResponse.json({ error: '用户不存在' }, { status: 404 });

  addMember(spaceId, userId, body.role);

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(spaceId) as
    | { name: string }
    | undefined;
  logOp(user.id, 'member', 'member', userId, target.username, `在空间「${space?.name ?? spaceId}」中设为 ${body.role}`);

  return NextResponse.json(
    {
      member: db
        .prepare('SELECT id, space_id, user_id, role, created_at FROM space_members WHERE space_id = ? AND user_id = ?')
        .get(spaceId, userId) as SpaceMember,
    },
    { status: 201 },
  );
}
