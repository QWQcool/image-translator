import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { Asset, Output } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/** 空间成品列表上限，防止超大空间一次拉爆 */
const MAX_OUTPUTS = 500;

/** 空间全部成品（联条目标题，新→旧），最多 500 条 */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'view');
  if (denied) return denied;

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
              a.size_bytes     AS a_size_bytes,
              a.title         AS a_title,
              a.source_url    AS a_source_url,
              a.source_author AS a_source_author,
              a.source_post_id AS a_source_post_id,
              a.visibility    AS a_visibility,
              a.created_at    AS a_created_at
         FROM outputs o
         JOIN space_items si ON si.id = o.item_id
         JOIN assets a ON a.id = o.asset_id
        WHERE si.space_id = ?
        ORDER BY o.id DESC
        LIMIT ${MAX_OUTPUTS}`,
    )
    .all(spaceId) as Array<
    Output & {
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
    }
  >;

  const outputs: Output[] = rows.map((row) => ({
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
  }));

  return NextResponse.json({ outputs });
}
