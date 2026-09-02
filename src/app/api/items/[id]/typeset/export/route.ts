import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { imageLimiter, storeImage } from '@/lib/storage';
import type { Asset } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/** 把嵌字成品写成空间里一张新图，不覆盖原图 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db
    .prepare('SELECT id, space_id, title FROM space_items WHERE id = ?')
    .get(itemId) as { id: number; space_id: number; title: string | null } | undefined;
  const access = item ? getSpaceAccess(item.space_id, user.id) : null;
  const denied = accessError(access, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: '缺少成品图' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const stored = await imageLimiter.run(() => storeImage(buffer, 'image/png'));
  const title = `${item.title || '未命名'}-嵌字`;
  const result = db
    .prepare(
      `INSERT INTO assets
         (owner_id, filename, thumb_filename, original_name, mime_type,
          width, height, size_bytes, title, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private')`,
    )
    .run(
      user.id,
      stored.filename,
      stored.thumbFilename,
      `${title}.png`,
      stored.storedMimeType,
      stored.width,
      stored.height,
      stored.sizeBytes,
      title,
    );

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM space_items WHERE space_id = ?')
    .get(item.space_id) as { m: number };
  db.prepare(
    `INSERT INTO space_items (space_id, asset_id, title, sort_order) VALUES (?, ?, ?, ?)`,
  ).run(item.space_id, result.lastInsertRowid, title, maxOrder.m + 1);

  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(result.lastInsertRowid) as Asset;
  logOp(user.id, 'upload', 'asset', asset.id, asset.title, `嵌字成品写入空间（来源条目：${itemDisplayName(itemId) ?? itemId}）`);
  return NextResponse.json({ asset }, { status: 201 });
}
