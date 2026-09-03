import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';

type NotificationRow = {
  id: number;
  actor_id: number | null;
  actor_name: string | null;
  item_id: number | null;
  space_id: number | null;
  item_title: string | null;
  body: string;
  read: number;
  created_at: string;
};

/**
 * 通知中心数据：当前用户的未读数 + 最新 20 条（含评论者用户名与条目标题）。
 * 仅站内通知，无邮件/推送。
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const unread = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0')
    .get(user.id) as { n: number };

  const rows = db
    .prepare(
      `SELECT n.id, n.actor_id, u.username AS actor_name,
              n.item_id, n.space_id, si.title AS item_title,
              n.body, n.read, n.created_at
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         LEFT JOIN space_items si ON si.id = n.item_id
        WHERE n.user_id = ?
        ORDER BY n.id DESC
        LIMIT 20`,
    )
    .all(user.id) as NotificationRow[];

  return NextResponse.json({
    unread: unread.n,
    items: rows.map((row) => ({
      id: row.id,
      actorName: row.actor_name,
      itemTitle: row.item_title,
      body: row.body,
      itemId: row.item_id,
      spaceId: row.space_id,
      read: Boolean(row.read),
      createdAt: row.created_at,
    })),
  });
}
