import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { deleteAvatar, saveAvatar } from '@/lib/profile';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function profileOf(user: {
  id: number;
  username: string;
  display_name: string | null;
  avatar_filename: string | null;
  is_admin: number;
  created_at: string;
}) {
  return {
    id: user.id,
    username: user.username,
    display_name: (user.display_name ?? '').trim() || null,
    avatar_url: user.avatar_filename ? `/api/profile/avatar/${user.avatar_filename}` : null,
    /** 管理员标记：仅用于前端决定是否渲染「邀请码管理」卡片，权限判定在接口层 */
    is_admin: user.is_admin === 1,
    created_at: user.created_at,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  return NextResponse.json({ profile: profileOf(user) });
}

/** 改昵称 / 移除头像。username 是注册账号名，不可改，日志/记录永远用它。 */
export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { display_name?: string; remove_avatar?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const displayName = (body.display_name ?? '').trim();
  if (displayName.length > 24) {
    return NextResponse.json({ error: '昵称最长 24 个字符' }, { status: 400 });
  }

  db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(displayName || null, user.id);

  let removedAvatar = false;
  if (body.remove_avatar && user.avatar_filename) {
    db.prepare(`UPDATE users SET avatar_filename = NULL WHERE id = ?`).run(user.id);
    await deleteAvatar(user.avatar_filename);
    removedAvatar = true;
  }

  const updated = db
    .prepare('SELECT id, username, display_name, avatar_filename, is_admin, created_at FROM users WHERE id = ?')
    .get(user.id) as Parameters<typeof profileOf>[0];
  return NextResponse.json({ profile: profileOf(updated), removedAvatar });
}

/** 上传头像：统一转 256x256 WebP，旧的文件随之清理 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: '没有收到图片文件' }, { status: 400 });
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return NextResponse.json({ error: '头像不能超过 5MB' }, { status: 400 });
  }
  if (!file.type.startsWith('image/')) {
    return NextResponse.json({ error: '只支持图片文件' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let filename: string;
  try {
    filename = await saveAvatar(user.id, buffer);
  } catch {
    return NextResponse.json({ error: '图片处理失败' }, { status: 400 });
  }

  db.prepare(`UPDATE users SET avatar_filename = ? WHERE id = ?`).run(filename, user.id);
  await deleteAvatar(user.avatar_filename);

  const updated = db
    .prepare('SELECT id, username, display_name, avatar_filename, is_admin, created_at FROM users WHERE id = ?')
    .get(user.id) as Parameters<typeof profileOf>[0];
  return NextResponse.json({ profile: profileOf(updated) });
}
