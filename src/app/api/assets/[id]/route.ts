import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { hardDeleteAssets } from '@/lib/hard-delete';
import { logOp } from '@/lib/oplog';
import type { Asset } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  let body: { title?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const title = (body.title ?? '').trim();
  if (!title) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
  if (title.length > 200) return NextResponse.json({ error: '名称过长' }, { status: 400 });

  const result = db
    .prepare('UPDATE assets SET title = ? WHERE id = ? AND owner_id = ?')
    .run(title, id, user.id);
  if (result.changes === 0) return NextResponse.json({ error: '图片不存在' }, { status: 404 });

  logOp(user.id, 'update', 'asset', id, title, '素材改名');
  return NextResponse.json({
    asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as Asset,
  });
}

/** 单个删除：与批量删除一致走彻底删除（含磁盘文件） */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const asset = db
    .prepare('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL')
    .get(id) as { id: number } | undefined;
  if (!asset) return NextResponse.json({ error: '图片不存在' }, { status: 404 });

  const result = await hardDeleteAssets([id], user.id);
  if (result.deleted === 0) {
    return NextResponse.json({ error: '图片不存在' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, detachedFromSpaces: result.detachedFromSpaces });
}
