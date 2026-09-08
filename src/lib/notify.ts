import { db } from './db';

/**
 * 空间参与者集合：annotations.updated_by ∪ comments.user_id ∪ spaces.owner_id 去重。
 * 协作事件通知（进度流转 / 存疑标记）的收件人推导——凡是在该空间动过标注或发过评论的人都算参与者。
 * 每个来源各自 LIMIT：防止大空间（上万条标注）把收件人推导拖成无界扫描。
 */
export function getSpaceParticipantIds(spaceId: number): number[] {
  const ids = new Set<number>();
  // owner 单行查询，不设上限
  const owner = db
    .prepare('SELECT owner_id FROM spaces WHERE id = ?')
    .get(spaceId) as { owner_id: number } | undefined;
  if (owner) ids.add(owner.owner_id);
  // 在该空间保存过标注的人（updated_by 可空 = 未编辑过，跳过）
  const annotators = db
    .prepare(
      `SELECT DISTINCT an.updated_by AS uid
         FROM annotations an
         JOIN space_items si ON si.id = an.item_id
        WHERE si.space_id = ? AND an.updated_by IS NOT NULL
        LIMIT 500`,
    )
    .all(spaceId) as Array<{ uid: number }>;
  for (const row of annotators) ids.add(row.uid);
  // 在该空间发过评论的人
  const commenters = db
    .prepare(
      `SELECT DISTINCT c.user_id AS uid
         FROM comments c
         JOIN space_items si ON si.id = c.item_id
        WHERE si.space_id = ? AND c.user_id IS NOT NULL
        LIMIT 500`,
    )
    .all(spaceId) as Array<{ uid: number }>;
  for (const row of commenters) ids.add(row.uid);
  return [...ids];
}

/**
 * 给空间参与者（排除操作者本人）各插一条站内通知。
 * 试用模式 / 单人操作场景下参与者排除自己后为空，自然返回 0（不发），调用方无需特判。
 * 通知失败绝不阻断业务主流程（进度流转、标注保存本身比通知更重要）。
 */
export function notifySpaceParticipants(options: {
  spaceId: number;
  actorId: number;
  /** 关联条目（可选：进度流转没有具体条目，传 null 时铃铛点击只跳空间） */
  itemId?: number | null;
  body: string;
}): number {
  const { spaceId, actorId, itemId = null, body } = options;
  try {
    const recipients = getSpaceParticipantIds(spaceId).filter((uid) => uid !== actorId);
    if (recipients.length === 0) return 0;
    const insert = db.prepare(
      `INSERT INTO notifications (user_id, actor_id, item_id, space_id, body)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // 事务包裹：保证通知要么全部写入要么全部不写，半截通知比没有更迷惑
    db.transaction(() => {
      for (const uid of recipients) insert.run(uid, actorId, itemId, spaceId, body);
    })();
    return recipients.length;
  } catch {
    // 通知写失败不影响主流程
    return 0;
  }
}
