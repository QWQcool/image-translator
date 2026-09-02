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
 * 开放空间模型：站点内没有私人空间，所有登录用户对所有文件夹都有编辑权；
 * 只有文件夹创建者保留管理权（改名/改描述/删除文件夹）。
 * space_members 表保留只是为了兼容历史数据与将来的"文件夹级可见性"，不再参与鉴权。
 */
export function getSpaceAccess(spaceId: number, userId: number): SpaceAccess | null {
  const space = db
    .prepare('SELECT id, owner_id, visibility FROM spaces WHERE id = ?')
    .get(spaceId) as { id: number; owner_id: number; visibility: SpaceVisibility } | undefined;
  if (!space) return null;

  const isOwner = space.owner_id === userId;
  return {
    role: isOwner ? 'owner' : 'editor',
    isMember: isOwner,
    canEdit: true,
    canManage: isOwner,
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
