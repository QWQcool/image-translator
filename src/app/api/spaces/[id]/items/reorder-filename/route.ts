import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { naturalSortBy } from '@/lib/natural-sort';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

/** 防御上限：与导出/终检等全空间操作同级（正常单空间 ≤ 200 条，留大余量） */
const MAX_ITEMS = 5000;

/**
 * 按文件名一键重排：对全空间条目按素材 original_name 自然排序（与 zip 导入建条目
 * 同规则，见 src/lib/natural-sort.ts），整体重写 sort_order，覆盖手动排序。
 * 排序键回退链：original_name → title → 保持当前顺序（无 key 条目稳定排在末尾）。
 */
export async function POST(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'edit');
  if (denied) return denied;

  const rows = db
    .prepare(
      `SELECT si.id,
              si.sort_order,
              IFNULL(a.original_name, '') AS original_name,
              IFNULL(si.title, '')        AS title
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.space_id = ?
        ORDER BY si.sort_order, si.id
        LIMIT ${MAX_ITEMS}`,
    )
    .all(spaceId) as Array<{
    id: number;
    sort_order: number;
    original_name: string;
    title: string;
  }>;

  if (rows.length === 0) {
    return NextResponse.json({ error: '空间内没有可排序的条目' }, { status: 400 });
  }

  // 排序键回退链：无 original_name 用 title，两者皆空按当前顺序（naturalSortBy 稳定排序）
  const sorted = naturalSortBy(rows, (row) => row.original_name || row.title || null);
  const sequence = sorted.map((row) => row.id);

  // 完全等于当前顺序时也照常重写：写值一致但语义明确（幂等），不做特判减少分支
  const update = db.prepare('UPDATE space_items SET sort_order = ? WHERE id = ?');
  db.transaction(() => {
    sequence.forEach((id, index) => update.run(index + 1, id));
    db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(spaceId);
  })();

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(spaceId) as
    | { name: string }
    | undefined;
  logOp(
    user.id,
    'sort',
    'space',
    spaceId,
    space?.name ?? `空间 ${spaceId}`,
    `按文件名重排 ${sequence.length} 页`,
  );

  const items = db
    .prepare('SELECT * FROM space_items WHERE space_id = ? ORDER BY sort_order, id')
    .all(spaceId);

  return NextResponse.json({ ok: true, items });
}
