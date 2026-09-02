import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { parseGroups, parseLabelPlus } from '@/lib/labelplus';
import type { Space } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'edit');
  if (denied) return denied;

  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const text = String(body.text ?? '');
  if (!text.trim()) return NextResponse.json({ error: '文件内容为空' }, { status: 400 });

  const doc = parseLabelPlus(text);
  if (doc.files.length === 0) {
    return NextResponse.json({ error: '没有识别到标号' }, { status: 400 });
  }

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as Space | undefined;
  if (!space) return NextResponse.json({ error: '空间不存在' }, { status: 404 });

  const items = db
    .prepare(
      `SELECT si.id, a.filename, a.original_name, si.title
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.space_id = ?`,
    )
    .all(spaceId) as Array<{ id: number; filename: string; original_name: string | null; title: string | null }>;

  const insert = db.prepare(
    `INSERT INTO annotations
       (item_id, x, y, w, h, text, font_size_ratio, color, bg_color, align, font_weight,
        order_index, kind, group_id, source_text, comment, updated_by)
     VALUES (?, ?, ?, 0, 0, ?, 0.035, '#FFFFFF', '#000000B3', 'left', 700,
        ?, 'pin', ?, '', '', ?)`,
  );
  const deletePins = db.prepare(`DELETE FROM annotations WHERE item_id = ? AND kind = 'pin'`);
  const maxOrder = db.prepare(
    `SELECT COALESCE(MAX(order_index), -1) AS m FROM annotations WHERE item_id = ?`,
  );

  let matched = 0;
  let imported = 0;
  const unmatched: string[] = [];

  const groupsFromFile = doc.groups.map((name, index) => ({ id: index + 1, name }));
  const existing = parseGroups(space.lp_groups);
  const mergedGroups = groupsFromFile.length > 0 ? groupsFromFile : existing;

  db.transaction(() => {
    db.prepare(`UPDATE spaces SET lp_groups = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(mergedGroups),
      spaceId,
    );

    for (const file of doc.files) {
      const key = file.filename.toLowerCase();
      const item = items.find(
        (row) =>
          row.original_name?.toLowerCase() === key ||
          row.filename.toLowerCase() === key ||
          row.title?.toLowerCase() === key,
      );
      if (!item) {
        unmatched.push(file.filename);
        continue;
      }
      matched += 1;
      deletePins.run(item.id);
      const start = (maxOrder.get(item.id) as { m: number }).m + 1;
      file.labels.forEach((label, index) => {
        insert.run(item.id, label.x, label.y, label.text, start + index, label.groupId, user.id);
        imported += 1;
      });
    }
  })();

  return NextResponse.json({ matched, imported, unmatched, groups: mergedGroups });
}
