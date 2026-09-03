import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { DEFAULT_LP_STYLES } from '@/lib/labelplus';
import { logOp } from '@/lib/oplog';
import { addMember } from '@/lib/permissions';
import type { Space, SpaceVisibility, SpaceWithCounts } from '@/lib/types';

/**
 * 可见范围：我参与的（任意角色）+ 我创建的 + 所有公开空间。
 * 后两者在不是成员时一律按 viewer 处理。
 */
const LIST_SQL = `
  SELECT s.*,
         (SELECT u.username FROM users u WHERE u.id = s.owner_id) AS owner_name,
         (SELECT COUNT(*) FROM space_items si WHERE si.space_id = s.id) AS item_count,
         (SELECT COUNT(*) FROM annotations an
            JOIN space_items si ON an.item_id = si.id
           WHERE si.space_id = s.id) AS annotation_count,
         (SELECT COUNT(*) FROM space_members sm WHERE sm.space_id = s.id) AS member_count,
         (SELECT si.id FROM space_items si
           WHERE si.space_id = s.id
           ORDER BY si.sort_order, si.id LIMIT 1) AS cover_item_id,
         (SELECT a.thumb_filename FROM space_items si
            JOIN assets a ON a.id = si.asset_id
           WHERE si.space_id = s.id
           ORDER BY si.sort_order, si.id LIMIT 1) AS cover_thumb,
         (SELECT a.filename FROM space_items si
            JOIN assets a ON a.id = si.asset_id
           WHERE si.space_id = s.id
           ORDER BY si.sort_order, si.id LIMIT 1) AS cover_filename,
         CASE
           WHEN m.role IS NOT NULL THEN m.role
           WHEN s.owner_id = ? THEN 'owner'
           ELSE 'viewer'
         END AS role
    FROM spaces s
    LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = ?
   WHERE (m.user_id IS NOT NULL OR s.owner_id = ? OR s.visibility = 'public') __SEARCH__
   ORDER BY (m.user_id IS NULL), s.updated_at DESC, s.id DESC
`;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  // 全局查找：LIKE 匹配空间名 / 描述
  const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim();
  const searchClause = keyword
    ? `AND (s.name LIKE ? OR IFNULL(s.description, '') LIKE ?)`
    : '';
  const searchArgs = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];

  const rows = db
    .prepare(LIST_SQL.replace('__SEARCH__', searchClause))
    .all(user.id, user.id, user.id, ...searchArgs) as Array<
    Omit<SpaceWithCounts, 'can_edit' | 'is_owner'>
  >;

  const spaces: SpaceWithCounts[] = rows.map((row) => ({
    ...row,
    can_edit: row.role === 'owner' || row.role === 'editor',
    is_owner: row.role === 'owner',
  }));

  return NextResponse.json({ spaces });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { name?: string; description?: string; visibility?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const name = (body.name ?? '').trim();
  const description = (body.description ?? '').trim() || null;
  // 开放空间：没有私人文件夹，请求里的 visibility 一律忽略
  const visibility: SpaceVisibility = 'public';

  if (!name) return NextResponse.json({ error: '空间名称不能为空' }, { status: 400 });
  if (name.length > 100) return NextResponse.json({ error: '空间名称过长' }, { status: 400 });

  // 建空间与写入 owner 成员必须在同一事务，否则中途失败会留下无主空间。
  // 新空间同时预置默认分组样式（与迁移回填对齐：组1 竖排深蓝，组2 横排蓝）。
  const createSpace = db.transaction(() => {
    const result = db
      .prepare(
        'INSERT INTO spaces (owner_id, name, description, visibility, lp_styles) VALUES (?, ?, ?, ?, ?)',
      )
      .run(user.id, name, description, visibility, JSON.stringify(DEFAULT_LP_STYLES));
    const spaceId = Number(result.lastInsertRowid);
    addMember(spaceId, user.id, 'owner');
    return spaceId;
  });

  const spaceId = createSpace();
  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as Space;

  logOp(user.id, 'space_create', 'space', spaceId, space.name);
  return NextResponse.json({ space }, { status: 201 });
}
