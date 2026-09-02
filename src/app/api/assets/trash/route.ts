import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { deleteImageFiles } from '@/lib/storage';

/**
 * 回收站操作：恢复 / 彻底删除。
 * - restore：deleted_at 置回 NULL，素材回到图库（空间引用在移入回收站时已解绑，不恢复）
 * - purge：真删——删除素材行并清理磁盘文件，不可恢复
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { ids?: number[]; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const ids = (body.ids ?? []).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    return NextResponse.json({ error: '未选择素材' }, { status: 400 });
  }
  if (body.action !== 'restore' && body.action !== 'purge') {
    return NextResponse.json({ error: 'action 必须是 restore 或 purge' }, { status: 400 });
  }

  const placeholders = ids.map(() => '?').join(',');
  const targets = db
    .prepare(
      `SELECT id, title, original_name, filename, thumb_filename FROM assets
        WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`,
    )
    .all(...ids) as Array<{
    id: number;
    title: string | null;
    original_name: string | null;
    filename: string;
    thumb_filename: string | null;
  }>;

  if (targets.length === 0) {
    return NextResponse.json({ error: '素材不在回收站中' }, { status: 404 });
  }

  const nameOf = (a: { id: number; title: string | null; original_name: string | null }) =>
    a.title ?? a.original_name ?? `素材 ${a.id}`;

  if (body.action === 'restore') {
    const restore = db.prepare(
      `UPDATE assets SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
    );
    const tx = db.transaction(() => {
      for (const asset of targets) restore.run(asset.id);
    });
    tx();
    for (const asset of targets) {
      logOp(user.id, 'restore', 'asset', asset.id, nameOf(asset), '从回收站恢复');
    }
    return NextResponse.json({ ok: true, affected: targets.length, action: 'restore' });
  }

  // 彻底删除：先删行（外键级联清理残留引用），再清磁盘文件
  const remove = db.prepare('DELETE FROM assets WHERE id = ?');
  const tx = db.transaction(() => {
    for (const asset of targets) remove.run(asset.id);
  });
  tx();
  await Promise.all(targets.map((a) => deleteImageFiles(a.filename, a.thumb_filename)));
  for (const asset of targets) {
    logOp(user.id, 'purge', 'asset', asset.id, nameOf(asset), '彻底删除（文件已清理）');
  }
  return NextResponse.json({ ok: true, affected: targets.length, action: 'purge' });
}
