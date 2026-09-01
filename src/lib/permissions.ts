import { NextResponse } from 'next/server';
import { db } from './db';
import type { SpaceAccess, SpaceRole, SpaceVisibility } from './types';

const ROLES = new Set<string>(['owner', 'editor', 'viewer']);

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && ROLES.has(value);
}

/**
 * 判定当前用户对某个空间的权限。返回 null 表示完全不可见。
 *
 * 优先级：成员表记录 > 空间所有者 > 公开空间的只读旁观者 > 无权限
 */
export function getSpaceAccess(spaceId: number, userId: number): SpaceAccess | null {
  const space = db
    .prepare('SELECT id, owner_id, visibility FROM spaces WHERE id = ?')
    .get(spaceId) as { id: number; owner_id: number; visibility: SpaceVisibility } | undefined;
  if (!space) return null;

  const member = db
    .prepare('SELECT role FROM space_members WHERE space_id = ? AND user_id = ?')
    .get(spaceId, userId) as { role: string } | undefined;

  let role: SpaceRole;
  let isMember = true;

  if (member && isSpaceRole(member.role)) {
    role = member.role;
  } else if (space.owner_id === userId) {
    role = 'owner';
  } else if (space.visibility === 'public') {
    role = 'viewer';
    isMember = false;
  } else {
    return null;
  }

  return {
    role,
    isMember,
    canEdit: role === 'owner' || role === 'editor',
    canManage: role === 'owner',
  };
}

/** 空间内 owner 的数量。用于阻止把最后一个 owner 降级或移除。 */
export function countOwners(spaceId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM space_members
        WHERE space_id = ? AND role = 'owner'`,
    )
    .get(spaceId) as { n: number };
  if (row.n > 0) return row.n;

  // 成员表为空（例如历史数据），回退到 spaces.owner_id
  const fallback = db
    .prepare('SELECT COUNT(*) AS n FROM spaces WHERE id = ? AND owner_id IS NOT NULL')
    .get(spaceId) as { n: number };
  return fallback.n;
}

export function addMember(spaceId: number, userId: number, role: SpaceRole): void {
  db.prepare(
    `INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role`,
  ).run(spaceId, userId, role);
}

/** 统一的鉴权响应：无访问权返回 404，有访问权但权限不足返回 403 */
export function accessError(
  access: SpaceAccess | null,
  require: 'view' | 'edit' | 'manage',
): NextResponse | null {
  if (!access) {
    return NextResponse.json({ error: '空间不存在或你无权访问' }, { status: 404 });
  }
  if (require === 'edit' && !access.canEdit) {
    return NextResponse.json({ error: '你在该空间仅有查看权限' }, { status: 403 });
  }
  if (require === 'manage' && !access.canManage) {
    return NextResponse.json({ error: '只有空间所有者可以执行此操作' }, { status: 403 });
  }
  return null;
}
