import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { deleteImageFiles } from '@/lib/storage';

type Params = { params: Promise<{ id: string }> };

/** 删除成品：outputs 行删除；成品 asset 无其它引用则连行与磁盘文件一起清 */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  // 权限跟随条目所在空间（扁平模型：登录 + edit 级即可删）
  const output = db
    .prepare(
      `SELECT o.id, o.asset_id, si.space_id, a.title AS asset_title, a.original_name
         FROM outputs o
         JOIN space_items si ON si.id = o.item_id
         JOIN assets a ON a.id = o.asset_id
        WHERE o.id = ?`,
    )
    .get(id) as
    | { id: number; asset_id: number; space_id: number; asset_title: string | null; original_name: string | null }
    | undefined;
  if (!output) return NextResponse.json({ error: '成品不存在' }, { status: 404 });

  const denied = accessError(getSpaceAccess(output.space_id, user.id), 'edit');
  if (denied) return denied;

  const asset = db
    .prepare('SELECT filename, thumb_filename FROM assets WHERE id = ?')
    .get(output.asset_id) as { filename: string; thumb_filename: string | null } | undefined;

  db.prepare('DELETE FROM outputs WHERE id = ?').run(id);

  // 成品 asset 不进 space_items；若也没有别的 outputs 引用它，行与磁盘文件一并清除。
  // 磁盘删除失败不回滚（孤儿文件无害），与 hard-delete 的策略一致。
  if (asset) {
    const refs = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM outputs WHERE asset_id = ?)
              + (SELECT COUNT(*) FROM space_items WHERE asset_id = ?) AS n`,
      )
      .get(output.asset_id, output.asset_id) as { n: number };
    if (refs.n === 0) {
      db.prepare('DELETE FROM assets WHERE id = ?').run(output.asset_id);
      await deleteImageFiles(asset.filename, asset.thumb_filename);
    }
  }

  logOp(
    user.id,
    'delete',
    'asset',
    output.asset_id,
    output.asset_title || output.original_name || `成品 ${id}`,
    '删除嵌字成品',
  );

  return NextResponse.json({ ok: true });
}
