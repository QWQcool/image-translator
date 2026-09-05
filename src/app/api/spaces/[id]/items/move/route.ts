import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const sourceSpaceId = Number((await params).id);
  if (!Number.isInteger(sourceSpaceId) || sourceSpaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  let body: { targetSpaceId?: number; itemIds?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const targetSpaceId = Number(body.targetSpaceId);
  if (!Number.isInteger(targetSpaceId) || targetSpaceId <= 0) {
    return NextResponse.json({ error: '目标空间无效' }, { status: 400 });
  }
  if (targetSpaceId === sourceSpaceId) {
    return NextResponse.json({ error: '目标空间不能与当前空间相同' }, { status: 400 });
  }

  const itemIds = [...new Set((body.itemIds ?? []).filter((id) => Number.isInteger(id)))];
  if (itemIds.length === 0) {
    return NextResponse.json({ error: '没有选择要移动的条目' }, { status: 400 });
  }

  // 权限校验：源空间与目标空间均需具有 edit 权限
  const sourceDenied = accessError(getSpaceAccess(sourceSpaceId, user.id), 'edit');
  if (sourceDenied) return sourceDenied;

  const targetDenied = accessError(getSpaceAccess(targetSpaceId, user.id), 'edit');
  if (targetDenied) return targetDenied;

  const sourceSpace = db.prepare('SELECT id, name FROM spaces WHERE id = ?').get(sourceSpaceId) as
    | { id: number; name: string }
    | undefined;
  const targetSpace = db.prepare('SELECT id, name FROM spaces WHERE id = ?').get(targetSpaceId) as
    | { id: number; name: string }
    | undefined;

  if (!sourceSpace || !targetSpace) {
    return NextResponse.json({ error: '空间不存在' }, { status: 404 });
  }

  // 查询源空间中确实存在的条目
  const placeholders = itemIds.map(() => '?').join(',');
  const sourceItems = db
    .prepare(
      `SELECT id, asset_id, title FROM space_items WHERE space_id = ? AND id IN (${placeholders})`,
    )
    .all(sourceSpaceId, ...itemIds) as Array<{ id: number; asset_id: number; title: string | null }>;

  if (sourceItems.length === 0) {
    return NextResponse.json({ error: '未找到符合条件的条目' }, { status: 404 });
  }

  // 目标空间已有的 asset_id 集合（防止违反 UNIQUE(space_id, asset_id) 约束）
  const targetExistingAssets = new Set(
    (
      db
        .prepare('SELECT asset_id FROM space_items WHERE space_id = ?')
        .all(targetSpaceId) as Array<{ asset_id: number }>
    ).map((r) => r.asset_id),
  );

  const maxTargetOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM space_items WHERE space_id = ?')
    .get(targetSpaceId) as { m: number };
  let nextOrder = maxTargetOrder.m + 1;

  const movedIds: number[] = [];
  const skippedTitles: string[] = [];

  db.transaction(() => {
    const updateStmt = db.prepare('UPDATE space_items SET space_id = ?, sort_order = ? WHERE id = ?');
    for (const item of sourceItems) {
      if (targetExistingAssets.has(item.asset_id)) {
        skippedTitles.push(item.title || `条目 #${item.id}`);
        continue;
      }
      updateStmt.run(targetSpaceId, nextOrder++, item.id);
      targetExistingAssets.add(item.asset_id);
      movedIds.push(item.id);
    }
    db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id IN (?, ?)`).run(
      sourceSpaceId,
      targetSpaceId,
    );
  })();

  logOp(
    user.id,
    'update',
    'space',
    targetSpaceId,
    targetSpace.name,
    `从空间「${sourceSpace.name}」移动 ${movedIds.length} 个条目至本空间`,
  );

  return NextResponse.json({
    success: true,
    movedCount: movedIds.length,
    skippedCount: skippedTitles.length,
    skippedTitles,
  });
}
