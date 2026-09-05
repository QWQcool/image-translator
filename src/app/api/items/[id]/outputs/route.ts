import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { imageLimiter, storeImage } from '@/lib/storage';
import type { Asset, Output } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/** base64 解码后的成品图体积上限 */
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;

/** outputs + assets 联表行 → Output 类型映射（GET 列表与 POST 返回共用） */
type OutputRow = Output & {
  a_id: number;
  a_owner_id: number;
  a_filename: string;
  a_thumb_filename: string | null;
  a_original_name: string | null;
  a_mime_type: string;
  a_width: number | null;
  a_height: number | null;
  a_size_bytes: number;
  a_title: string | null;
  a_source_url: string | null;
  a_source_author: string | null;
  a_source_post_id: string | null;
  a_visibility: string;
  a_created_at: string;
};

function mapOutput(row: OutputRow): Output {
  return {
    id: row.id,
    item_id: row.item_id,
    asset_id: row.asset_id,
    created_by: row.created_by,
    created_at: row.created_at,
    item_title: row.item_title ?? null,
    asset: {
      id: row.a_id,
      owner_id: row.a_owner_id,
      filename: row.a_filename,
      thumb_filename: row.a_thumb_filename,
      original_name: row.a_original_name,
      mime_type: row.a_mime_type,
      width: row.a_width,
      height: row.a_height,
      size_bytes: row.a_size_bytes,
      title: row.a_title,
      source_url: row.a_source_url,
      source_author: row.a_source_author,
      source_post_id: row.a_source_post_id,
      visibility: row.a_visibility as Asset['visibility'],
      created_at: row.a_created_at,
    },
  };
}

/** 某条目的全部成品版本（新→旧） */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db
    .prepare('SELECT id, space_id FROM space_items WHERE id = ?')
    .get(itemId) as { id: number; space_id: number } | undefined;
  const access = item ? getSpaceAccess(item.space_id, user.id) : null;
  const denied = accessError(access, 'view');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  const rows = db
    .prepare(
      `SELECT o.id, o.item_id, o.asset_id, o.created_by, o.created_at,
              si.title AS item_title,
              a.id            AS a_id,
              a.owner_id      AS a_owner_id,
              a.filename      AS a_filename,
              a.thumb_filename AS a_thumb_filename,
              a.original_name AS a_original_name,
              a.mime_type     AS a_mime_type,
              a.width         AS a_width,
              a.height        AS a_height,
              a.size_bytes    AS a_size_bytes,
              a.title         AS a_title,
              a.source_url    AS a_source_url,
              a.source_author AS a_source_author,
              a.source_post_id AS a_source_post_id,
              a.visibility    AS a_visibility,
              a.created_at    AS a_created_at
         FROM outputs o
         JOIN space_items si ON si.id = o.item_id
         JOIN assets a ON a.id = o.asset_id
        WHERE o.item_id = ?
        ORDER BY o.id DESC`,
    )
    .all(itemId) as OutputRow[];

  return NextResponse.json({ outputs: rows.map(mapOutput) });
}

/**
 * 保存嵌字成品：body { image: base64 PNG }（可带 data URL 前缀）。
 * 成品图走现有 storage 管线落盘并建独立 assets 行（成品产物，非空间条目，
 * 不插 space_items、不进空间图片列表），仅被 outputs 表引用。
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db
    .prepare('SELECT id, space_id, title FROM space_items WHERE id = ?')
    .get(itemId) as { id: number; space_id: number; title: string | null } | undefined;
  const access = item ? getSpaceAccess(item.space_id, user.id) : null;
  const denied = accessError(access, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  let body: { image?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const raw = body.image ?? '';
  if (!raw) return NextResponse.json({ error: '缺少成品图' }, { status: 400 });
  const base64 = raw.replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    return NextResponse.json({ error: '成品图数据无效' }, { status: 400 });
  }
  if (buffer.length > MAX_OUTPUT_BYTES) {
    return NextResponse.json({ error: '成品图超过 30MB 限制' }, { status: 400 });
  }

  // 能 base64 解码但不是合法图片（如随手编码的文本）在这里拦成 400 而非 500
  let stored: Awaited<ReturnType<typeof storeImage>>;
  try {
    stored = await imageLimiter.run(() => storeImage(buffer, 'image/png'));
  } catch {
    return NextResponse.json({ error: '成品图数据无效（不是合法的 PNG 图片）' }, { status: 400 });
  }
  const title = `${item.title || '未命名'}-成品`;

  // asset 行与 outputs 行同事务落库，避免半截记录
  const ids = db.transaction(() => {
    const assetResult = db
      .prepare(
        `INSERT INTO assets
           (owner_id, filename, thumb_filename, original_name, mime_type,
            width, height, size_bytes, title, visibility, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?)`,
      )
      .run(
        user.id,
        stored.filename,
        stored.thumbFilename,
        `${title}.png`,
        stored.storedMimeType,
        stored.width,
        stored.height,
        stored.sizeBytes,
        title,
        stored.sha256,
      );
    const assetId = Number(assetResult.lastInsertRowid);
    const outputResult = db
      .prepare('INSERT INTO outputs (item_id, asset_id, created_by) VALUES (?, ?, ?)')
      .run(itemId, assetId, user.id);

    // 制作人员自动填充：若空间「嵌字」为空，保存成品图时自动填入当前用户昵称
    const spaceRow = db.prepare('SELECT typesetter FROM spaces WHERE id = ?').get(item.space_id) as
      | { typesetter: string }
      | undefined;
    if (spaceRow && !spaceRow.typesetter) {
      db.prepare('UPDATE spaces SET typesetter = ? WHERE id = ?').run(user.username, item.space_id);
    }

    return { assetId, outputId: Number(outputResult.lastInsertRowid) };
  })();

  const count = db.prepare('SELECT COUNT(*) AS n FROM outputs WHERE item_id = ?').get(itemId) as {
    n: number;
  };

  logOp(
    user.id,
    'upload',
    'asset',
    ids.assetId,
    title,
    `保存嵌字成品（来源条目：${itemDisplayName(itemId) ?? itemId}）`,
  );

  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(ids.assetId) as Asset;
  const output: Output = {
    id: ids.outputId,
    item_id: itemId,
    asset_id: ids.assetId,
    created_by: user.id,
    created_at: new Date().toISOString(),
    item_title: item.title,
    asset,
  };
  return NextResponse.json({ output, count: count.n }, { status: 201 });
}
