import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { hardDeleteItems } from '@/lib/hard-delete';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { SpaceItem } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/** 把图库中的图片加入空间（旧入口，界面已改为直接上传，保留兼容） */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  let body: { assetIds?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const assetIds = [...new Set((body.assetIds ?? []).filter((id) => Number.isInteger(id)))];
  if (assetIds.length === 0) {
    return NextResponse.json({ error: '没有选择图片' }, { status: 400 });
  }

  // 往空间里加图片属于「改」，viewer 不允许
  const denied = accessError(getSpaceAccess(spaceId, user.id), 'edit');
  if (denied) return denied;

  // 可用范围＝自己的素材 ＋ 共享图库中被他人共享出来的素材；历史软删除素材不可加入
  const placeholders = assetIds.map(() => '?').join(',');
  const assets = db
    .prepare(
      `SELECT id, title FROM assets
        WHERE (owner_id = ? OR visibility = 'shared') AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .all(user.id, ...assetIds) as { id: number; title: string | null }[];

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM space_items WHERE space_id = ?')
    .get(spaceId) as { m: number };

  const insert = db.prepare(
    `INSERT OR IGNORE INTO space_items (space_id, asset_id, title, sort_order)
     VALUES (?, ?, ?, ?)`,
  );
  const touchSpace = db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`);

  let nextOrder = maxOrder.m + 1;
  db.transaction(() => {
    for (const asset of assets) {
      insert.run(spaceId, asset.id, asset.title, nextOrder++);
    }
    touchSpace.run(spaceId);
  })();

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(spaceId) as
    | { name: string }
    | undefined;
  logOp(
    user.id,
    'create',
    'item',
    null,
    assets[0]?.title ?? null,
    `向空间「${space?.name ?? spaceId}」添加 ${assets.length} 个条目`,
  );

  const items = db
    .prepare('SELECT * FROM space_items WHERE space_id = ? ORDER BY sort_order, id')
    .all(spaceId) as SpaceItem[];

  return NextResponse.json({ items, added: assets.length }, { status: 201 });
}

/**
 * 批量删除空间条目：彻底删除（条目 + 标注 + 不再被引用的素材与磁盘文件）。
 * 删除即删除，不再有回收站。
 */
export async function DELETE(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  let body: { itemIds?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const itemIds = [...new Set((body.itemIds ?? []).filter((id) => Number.isInteger(id)))];
  if (itemIds.length === 0) {
    return NextResponse.json({ error: '没有选择要删除的图片' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'edit');
  if (denied) return denied;

  // 只删属于该空间的条目，防止跨空间误删
  const placeholders = itemIds.map(() => '?').join(',');
  const owned = db
    .prepare(
      `SELECT id FROM space_items WHERE space_id = ? AND id IN (${placeholders})`,
    )
    .all(spaceId, ...itemIds) as Array<{ id: number }>;
  if (owned.length === 0) {
    return NextResponse.json({ error: '条目不属于该空间' }, { status: 404 });
  }

  const result = await hardDeleteItems(
    owned.map((row) => row.id),
    user.id,
  );

  return NextResponse.json({
    deleted: result.deleted,
    assetsDeleted: result.assetsDeleted,
    assetsKept: result.assetsKept,
  });
}
