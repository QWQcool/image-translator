import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
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

/** 单个删除：与批量删除一致走软删除（进回收站），磁盘文件保留 */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const asset = db
    .prepare(
      'SELECT id, owner_id, title, original_name FROM assets WHERE id = ? AND owner_id = ? AND deleted_at IS NULL',
    )
    .get(id, user.id) as
    | { id: number; owner_id: number; title: string | null; original_name: string | null }
    | undefined;
  if (!asset) return NextResponse.json({ error: '图片不存在或已在回收站' }, { status: 404 });

  // 与批量删除保持一致：告知用户这次删除影响了多少处协作空间引用
  const usage = db
    .prepare('SELECT COUNT(*) AS n FROM space_items WHERE asset_id = ?')
    .get(id) as { n: number };

  db.transaction(() => {
    db.prepare('DELETE FROM space_items WHERE asset_id = ?').run(id);
    db.prepare(`UPDATE assets SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  })();

  logOp(
    user.id,
    'delete',
    'asset',
    asset.id,
    asset.title ?? asset.original_name ?? `素材 ${asset.id}`,
    '移入回收站',
  );

  return NextResponse.json({ ok: true, detachedFromSpaces: usage.n });
}
