import { db } from './db';
import { logOp } from './oplog';
import { deleteImageFiles } from './storage';

/**
 * 彻底删除空间条目：条目行 + 标注（外键级联）+ 不再被引用的素材行与磁盘文件。
 * 同一素材被多个空间的条目共用时，只删当前条目，素材保留给其它空间。
 * 日志：每条目一条 purge 记录。
 */
export async function hardDeleteItems(
  itemIds: number[],
  userId: number,
): Promise<{ deleted: number; assetsDeleted: number; assetsKept: number }> {
  if (itemIds.length === 0) return { deleted: 0, assetsDeleted: 0, assetsKept: 0 };
  const placeholders = itemIds.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT si.id, si.space_id, si.title, si.asset_id,
              a.filename          AS asset_filename,
              a.thumb_filename    AS asset_thumb_filename,
              a.title             AS asset_title,
              a.original_name     AS asset_original_name,
              (SELECT COUNT(*) FROM annotations an WHERE an.item_id = si.id) AS annotation_count
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.id IN (${placeholders})`,
    )
    .all(...itemIds) as Array<{
    id: number;
    space_id: number;
    title: string | null;
    asset_id: number;
    asset_filename: string;
    asset_thumb_filename: string | null;
    asset_title: string | null;
    asset_original_name: string | null;
    annotation_count: number;
  }>;
  if (rows.length === 0) return { deleted: 0, assetsDeleted: 0, assetsKept: 0 };

  const filesToDelete: Array<{ filename: string; thumbFilename: string | null }> = [];
  let assetsKept = 0;

  db.transaction(() => {
    for (const row of rows) {
      db.prepare('DELETE FROM space_items WHERE id = ?').run(row.id);
      // notifications.item_id 无外键，删除条目时顺带清掉相关通知（避免死链通知）
      db.prepare('DELETE FROM notifications WHERE item_id = ?').run(row.id);
      db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(row.space_id);

      // 删完本条目后素材若无任何空间引用，则素材行与磁盘文件一并清除
      const refs = db
        .prepare('SELECT COUNT(*) AS n FROM space_items WHERE asset_id = ?')
        .get(row.asset_id) as { n: number };
      if (refs.n === 0) {
        db.prepare('DELETE FROM assets WHERE id = ?').run(row.asset_id);
        filesToDelete.push({
          filename: row.asset_filename,
          thumbFilename: row.asset_thumb_filename,
        });
      } else {
        assetsKept += 1;
      }

      const name = row.title || row.asset_title || row.asset_original_name || `条目 ${row.id}`;
      logOp(
        userId,
        'purge',
        'item',
        row.id,
        name,
        `彻底删除条目（含 ${row.annotation_count} 条标注${
          refs.n === 0 ? '与素材文件' : '，素材仍被其它空间引用故保留'
        }）`,
      );
    }
  })();

  // 磁盘文件删除放在事务提交之后，失败不影响数据库一致性（孤儿文件无害）
  await Promise.all(filesToDelete.map((f) => deleteImageFiles(f.filename, f.thumbFilename)));

  return { deleted: rows.length, assetsDeleted: filesToDelete.length, assetsKept };
}

/**
 * 彻底删除素材：解绑全部空间条目（标注级联）+ 删除素材行 + 删除磁盘文件。
 */
export async function hardDeleteAssets(
  assetIds: number[],
  userId: number,
): Promise<{ deleted: number; detachedFromSpaces: number }> {
  if (assetIds.length === 0) return { deleted: 0, detachedFromSpaces: 0 };
  const placeholders = assetIds.map(() => '?').join(',');

  const rows = db
    .prepare(
      `SELECT id, filename, thumb_filename, title, original_name
         FROM assets
        WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .all(...assetIds) as Array<{
    id: number;
    filename: string;
    thumb_filename: string | null;
    title: string | null;
    original_name: string | null;
  }>;
  if (rows.length === 0) return { deleted: 0, detachedFromSpaces: 0 };

  const usage = db
    .prepare(`SELECT COUNT(*) AS n FROM space_items WHERE asset_id IN (${placeholders})`)
    .get(...rows.map((r) => r.id)) as { n: number };

  const files = rows.map((r) => ({ filename: r.filename, thumbFilename: r.thumb_filename }));

  db.transaction(() => {
    for (const row of rows) {
      db.prepare('DELETE FROM space_items WHERE asset_id = ?').run(row.id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
    }
  })();

  await Promise.all(files.map((f) => deleteImageFiles(f.filename, f.thumbFilename)));

  for (const row of rows) {
    logOp(
      userId,
      'purge',
      'asset',
      row.id,
      row.title || row.original_name || `素材 ${row.id}`,
      '彻底删除素材（含磁盘文件）',
    );
  }

  return { deleted: rows.length, detachedFromSpaces: usage.n };
}
