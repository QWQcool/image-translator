import { db } from './db';

/**
 * 操作日志动作枚举。尽量覆盖现有写路径：
 * create/update/delete/upload/space_create/space_delete/member，
 * 以及软删除恢复（restore）、彻底删除（purge）、AI 调用（ai_ocr/ai_inpaint）。
 */
export type OpAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'upload'
  | 'sort'
  | 'space_create'
  | 'space_delete'
  | 'member'
  | 'restore'
  | 'purge'
  | 'ai_ocr'
  | 'ai_inpaint'
  | 'ai_translate';

export type OpTargetType = 'space' | 'item' | 'asset' | 'member' | 'ai';

/**
 * 写入一条操作日志。日志失败绝不阻断业务主流程，
 * 所以调用处不需要 try/catch，直接放在写操作成功之后即可。
 */
export function logOp(
  userId: number,
  action: OpAction,
  targetType: OpTargetType,
  targetId: number | null,
  targetName: string | null,
  detail?: string | null,
): void {
  try {
    db.prepare(
      `INSERT INTO op_logs (user_id, action, target_type, target_id, target_name, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, action, targetType, targetId, targetName, detail ?? null);
  } catch {
    // 日志写失败不影响主流程
  }
}

/** 空间条目的展示名：条目标题优先，退回素材文件名，再退回「条目 N」 */
export function itemDisplayName(itemId: number): string | null {
  const row = db
    .prepare(
      `SELECT si.title, a.original_name
         FROM space_items si JOIN assets a ON a.id = si.asset_id
        WHERE si.id = ?`,
    )
    .get(itemId) as { title: string | null; original_name: string | null } | undefined;
  if (!row) return null;
  return row.title || row.original_name || `条目 ${itemId}`;
}
