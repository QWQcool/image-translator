import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { SpaceItem } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/** 把图库中的图片加入空间 */
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

  // 可用范围＝自己的素材 ＋ 共享图库中被他人共享出来的素材
  const placeholders = assetIds.map(() => '?').join(',');
  const assets = db
    .prepare(
      `SELECT id, title FROM assets
        WHERE (owner_id = ? OR visibility = 'shared') AND id IN (${placeholders})`,
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

  const items = db
    .prepare('SELECT * FROM space_items WHERE space_id = ? ORDER BY sort_order, id')
    .all(spaceId) as SpaceItem[];

  return NextResponse.json({ items, added: assets.length }, { status: 201 });
}
