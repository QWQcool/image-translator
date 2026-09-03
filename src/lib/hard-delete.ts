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
      // 删条目前先收集它的成品 asset：outputs 行会随条目级联删除，引用信息要先取出
      const outputAssets = db
        .prepare(
          `SELECT o.asset_id, a.filename, a.thumb_filename
             FROM outputs o JOIN assets a ON a.id = o.asset_id
            WHERE o.item_id = ?`,
        )
        .all(row.id) as Array<{
        asset_id: number;
        filename: string;
        thumb_filename: string | null;
      }>;

      db.prepare('DELETE FROM space_items WHERE id = ?').run(row.id);
      // notifications.item_id 无外键，删除条目时顺带清掉相关通知（避免死链通知）
      db.prepare('DELETE FROM notifications WHERE item_id = ?').run(row.id);
      db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(row.space_id);

      // 成品 asset 不进 space_items，仅被 outputs 引用。本条目的 outputs 已随级联清空，
      // 若成品 asset 没被其它条目的 outputs 继续引用，则行与磁盘文件一并清除，
      // 否则成品图会变成永远删不掉的孤儿文件。
      let outputsDeleted = 0;
      for (const output of outputAssets) {
        const remaining = db
          .prepare('SELECT COUNT(*) AS n FROM outputs WHERE asset_id = ?')
          .get(output.asset_id) as { n: number };
        if (remaining.n === 0) {
          db.prepare('DELETE FROM assets WHERE id = ?').run(output.asset_id);
          filesToDelete.push({
            filename: output.filename,
            thumbFilename: output.thumb_filename,
          });
          outputsDeleted += 1;
        }
      }

      // 删完本条目后素材若无任何引用（space_items + outputs 都要算），
      // 则素材行与磁盘文件一并清除。漏算 outputs 会把成品图的上游素材误删成死链。
      const refs = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM space_items WHERE asset_id = ?)
                + (SELECT COUNT(*) FROM outputs   WHERE asset_id = ?) AS n`,
        )
        .get(row.asset_id, row.asset_id) as { n: number };
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
        `彻底删除条目（含 ${row.annotation_count} 条标注` +
          (outputsDeleted > 0 ? `、${outputsDeleted} 个成品文件` : '') +
          (refs.n === 0 ? '与素材文件' : '，素材仍被其它引用故保留') +
          '）',
      );
    }
  })();

  // 磁盘文件删除放在事务提交之后，失败不影响数据库一致性（孤儿文件无害）
  await Promise.all(filesToDelete.map((f) => deleteImageFiles(f.filename, f.thumbFilename)));

  return { deleted: rows.length, assetsDeleted: filesToDelete.length, assetsKept };
}

/**
 * 彻底删除素材：解绑全部空间条目（标注级联）+ 删除素材行 + 删除磁盘文件。
 * 若素材是某个条目的成品（outputs 引用），outputs 行随 assets 外键级联删除，
 * 无需单独处理；正常成品删除应走 /api/outputs/[id]。
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

  // 被删素材所在条目的成品 asset：条目删除后 outputs 随 item 级联清空，
  // 成品行会消失，但成品 asset 行与磁盘文件不会自动清——先收集，删除后按引用计数清理
  const outputAssets = db
    .prepare(
      `SELECT DISTINCT a.id, a.filename, a.thumb_filename
         FROM space_items si
         JOIN outputs o ON o.item_id = si.id
         JOIN assets a ON a.id = o.asset_id
        WHERE si.asset_id IN (${placeholders})
          AND a.id NOT IN (${placeholders})`,
    )
    .all(...assetIds, ...assetIds) as Array<{
    id: number;
    filename: string;
    thumb_filename: string | null;
  }>;

  const files = rows.map((r) => ({ filename: r.filename, thumbFilename: r.thumb_filename }));

  db.transaction(() => {
    for (const row of rows) {
      db.prepare('DELETE FROM space_items WHERE asset_id = ?').run(row.id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
    }
    // 成品 asset 引用计数归零（outputs 已随条目级联清空）才删行，文件随事务后统一清
    for (const oa of outputAssets) {
      const refs = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM space_items WHERE asset_id = ?)
                + (SELECT COUNT(*) FROM outputs   WHERE asset_id = ?) AS n`,
        )
        .get(oa.id, oa.id) as { n: number };
      if (refs.n === 0) {
        db.prepare('DELETE FROM assets WHERE id = ?').run(oa.id);
        files.push({ filename: oa.filename, thumbFilename: oa.thumb_filename });
      }
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
