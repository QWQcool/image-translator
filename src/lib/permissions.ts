import { NextResponse } from 'next/server';
import { db } from './db';
import type { SpaceAccess, SpaceRole, SpaceVisibility } from './types';

const ROLES = new Set<string>(['owner', 'editor', 'viewer']);

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && ROLES.has(value);
}

/**
 * 判定当前用户对某个空间的权限。返回 null 表示完全不可见（仅发生在空间不存在时）。
 *
 * 权限扁平化模型：**所有登录用户对所有空间一律拥有完整权限**——
 * 上传/改名/排序/删除图片、编辑标注、改空间信息（名称/描述）、删除空间、管理成员，
 * 不区分创建者/编辑者层级。站点内唯一保留的权限差异是
 * 「管理员可生成/作废邀请码」，由 users.is_admin 控制，与空间无关。
 * space_members 表与 spaces.owner_id 保留只为兼容历史数据与展示「我创建的」，不再参与鉴权。
 */
export function getSpaceAccess(spaceId: number, userId: number): SpaceAccess | null {
  const space = db
    .prepare('SELECT id, owner_id, visibility FROM spaces WHERE id = ?')
    .get(spaceId) as { id: number; owner_id: number; visibility: SpaceVisibility } | undefined;
  if (!space) return null;

  // role 仅作为展示信息保留（owner 标记「我创建的」分组），不再影响任何权限判定
  const isOwner = space.owner_id === userId;
  return {
    role: isOwner ? 'owner' : 'editor',
    isMember: true,
    canEdit: true,
    canManage: true,
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

/**
 * 统一的鉴权响应：无访问权返回 404，权限不足返回 403。
 * 权限扁平化后登录用户恒有 canEdit/canManage，403 分支实际不会触发，
 * 保留只为防御未来的权限收紧与类型完整性。
 */
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
