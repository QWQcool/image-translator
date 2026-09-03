import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { adminForbidden, getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';

/**
 * 管理员邀请码接口。
 * 站点权限已扁平化（登录即全权），管理员是唯一保留的权限差异：
 * 仅管理员可以生成/查看/作废邀请码，非管理员一律 403。
 */

type InviteRow = {
  id: number;
  code: string;
  created_by: number | null;
  used_by: number | null;
  used_at: string | null;
  created_at: string;
  created_by_username?: string | null;
  used_by_username?: string | null;
};

function listInvites(): InviteRow[] {
  return db
    .prepare(
      `SELECT ic.id, ic.code, ic.created_by, ic.used_by, ic.used_at, ic.created_at,
              cu.username AS created_by_username,
              uu.username AS used_by_username
         FROM invite_codes ic
         LEFT JOIN users cu ON cu.id = ic.created_by
         LEFT JOIN users uu ON uu.id = ic.used_by
        ORDER BY ic.id DESC`,
    )
    .all() as InviteRow[];
}

function serialize(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    createdBy: row.created_by_username ?? (row.created_by ? `用户 ${row.created_by}` : null),
    usedBy: row.used_by_username ?? (row.used_by ? `用户 ${row.used_by}` : null),
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

/** 全量倒序列出邀请码（仅管理员） */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  const denied = adminForbidden(user);
  if (denied) return denied;

  return NextResponse.json({ codes: listInvites().map(serialize) });
}

/**
 * 生成一个新邀请码并返回明文（只此一次可见）。
 * 9 字节随机数 → 12 个 base64url 字符，正好按 XXXX-XXXX-XXXX 分段展示。
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  const denied = adminForbidden(user);
  if (denied) return denied;

  // 自定义字母表：不含 -/_/易混淆的 0O1Iil，避免手动誊写出错（12 字符分 4-4-4）
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(12);
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  const code = (raw.match(/.{1,4}/g) ?? [raw]).join('-');

  const result = db
    .prepare('INSERT INTO invite_codes (code, created_by) VALUES (?, ?)')
    .run(code, user.id);

  logOp(user.id, 'invite_create', 'invite', Number(result.lastInsertRowid), code, '生成邀请码');

  return NextResponse.json(
    {
      code: serialize(
        listInvites().find((row) => row.id === Number(result.lastInsertRowid)) as InviteRow,
      ),
    },
    { status: 201 },
  );
}
