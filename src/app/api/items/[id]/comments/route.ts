import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type CommentRow = {
  id: number;
  user_id: number | null;
  username: string | null;
  body: string;
  created_at: string;
};

/** 评论正文上限（trim 后 1~500 字） */
const MAX_BODY_LENGTH = 500;

/**
 * 条目评论（标注编辑器页讨论）。
 * GET：登录 + 空间 view 权限，按时间升序返回。
 */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(itemId) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'view');
  if (denied) return denied;

  const rows = db
    .prepare(
      `SELECT c.id, c.user_id, u.username, c.body, c.created_at
         FROM comments c
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.item_id = ?
        ORDER BY c.created_at, c.id`,
    )
    .all(itemId) as CommentRow[];

  return NextResponse.json({
    comments: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      body: row.body,
      createdAt: row.created_at,
    })),
  });
}

/**
 * 发表评论：登录 + view 即可（viewer 也能参与讨论）。
 * 成功后向「相关人」发站内通知：本条目标注的最后编辑者 ∪ 历史评论者 ∪ 空间创建者，
 * 去重并排除评论者本人；body 存评论前 60 字摘要。
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(itemId) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'view');
  if (denied || !item) {
    return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });
  }

  let body: { body?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const text = String(body.body ?? '').trim();
  if (!text) return NextResponse.json({ error: '评论内容不能为空' }, { status: 400 });
  if (text.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ error: `评论最多 ${MAX_BODY_LENGTH} 字` }, { status: 400 });
  }

  // 收件人集合：标注最后编辑者（updated_by 非空）∪ 历史评论者 ∪ 空间创建者，排除自己
  const recipients = new Set<number>();
  const editors = db
    .prepare(
      `SELECT DISTINCT updated_by AS uid FROM annotations
        WHERE item_id = ? AND updated_by IS NOT NULL`,
    )
    .all(itemId) as Array<{ uid: number }>;
  for (const row of editors) recipients.add(row.uid);
  const commenters = db
    .prepare(
      `SELECT DISTINCT user_id AS uid FROM comments
        WHERE item_id = ? AND user_id IS NOT NULL`,
    )
    .all(itemId) as Array<{ uid: number }>;
  for (const row of commenters) recipients.add(row.uid);
  const space = db.prepare('SELECT owner_id FROM spaces WHERE id = ?').get(item.space_id) as
    | { owner_id: number }
    | undefined;
  if (space) recipients.add(space.owner_id);
  recipients.delete(user.id);

  const insertComment = db.prepare(
    'INSERT INTO comments (item_id, user_id, body) VALUES (?, ?, ?)',
  );
  const insertNotification = db.prepare(
    `INSERT INTO notifications (user_id, actor_id, item_id, space_id, body)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const created = db.transaction(() => {
    const result = insertComment.run(itemId, user.id, text);
    const commentId = Number(result.lastInsertRowid);
    // 摘要 = 评论前 60 字
    const summary = text.slice(0, 60);
    for (const uid of recipients) {
      insertNotification.run(uid, user.id, itemId, item.space_id, summary);
    }
    return commentId;
  })();

  return NextResponse.json(
    {
      comment: {
        id: created,
        userId: user.id,
        username: user.username,
        body: text,
        createdAt: new Date().toISOString(),
      },
      notified: recipients.size,
    },
    { status: 201 },
  );
}
