import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { Asset, Space, SpaceAccess, SpaceItem } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

/** 取出条目并判定当前用户在其所属空间的权限；无权访问时返回 null */
function loadAccessibleItem(
  itemId: number,
  userId: number,
): { item: SpaceItem; access: SpaceAccess } | null {
  const item = db.prepare('SELECT * FROM space_items WHERE id = ?').get(itemId) as
    | SpaceItem
    | undefined;
  if (!item) return null;
  const access = getSpaceAccess(item.space_id, userId);
  if (!access) return null;
  return { item, access };
}

/** 标注编辑器初始化所需：条目 + 素材 + 所属空间 */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const viewing = loadAccessibleItem(id, user.id);
  const viewDenied = accessError(viewing?.access ?? null, 'view');
  if (viewDenied || !viewing) {
    return viewDenied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });
  }

  const row = db
    .prepare(
      `SELECT si.id          AS item_id,
              si.space_id    AS item_space_id,
              si.asset_id    AS item_asset_id,
              si.title       AS item_title,
              si.sort_order  AS item_sort_order,
              si.created_at  AS item_created_at,
              a.id           AS asset_id,
              a.owner_id     AS asset_owner_id,
              a.filename     AS asset_filename,
              a.thumb_filename AS asset_thumb_filename,
              a.original_name  AS asset_original_name,
              a.mime_type    AS asset_mime_type,
              a.width        AS asset_width,
              a.height       AS asset_height,
              a.size_bytes   AS asset_size_bytes,
              a.title        AS asset_title,
              a.source_url   AS asset_source_url,
              a.source_author AS asset_source_author,
              a.source_post_id AS asset_source_post_id,
              a.visibility   AS asset_visibility,
              a.created_at   AS asset_created_at,
              s.id           AS space_id,
              s.name         AS space_name,
              s.visibility   AS space_visibility
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
         JOIN spaces s ON s.id = si.space_id
        WHERE si.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return NextResponse.json({ error: '条目不存在' }, { status: 404 });

  const item: SpaceItem = {
    id: row.item_id as number,
    space_id: row.item_space_id as number,
    asset_id: row.item_asset_id as number,
    title: row.item_title as string | null,
    sort_order: row.item_sort_order as number,
    created_at: row.item_created_at as string,
  };
  const asset: Asset = {
    id: row.asset_id as number,
    owner_id: row.asset_owner_id as number,
    filename: row.asset_filename as string,
    thumb_filename: row.asset_thumb_filename as string | null,
    original_name: row.asset_original_name as string | null,
    mime_type: row.asset_mime_type as string,
    width: row.asset_width as number | null,
    height: row.asset_height as number | null,
    size_bytes: row.asset_size_bytes as number,
    title: row.asset_title as string | null,
    source_url: row.asset_source_url as string | null,
    source_author: row.asset_source_author as string | null,
    source_post_id: row.asset_source_post_id as string | null,
    visibility: row.asset_visibility as Asset['visibility'],
    created_at: row.asset_created_at as string,
    };
  const space: Space = {
    id: row.space_id as number,
    owner_id: user.id,
    name: row.space_name as string,
    description: null,
    visibility: row.space_visibility as Space['visibility'],
    created_at: '',
    updated_at: '',
  };

  return NextResponse.json({ item, asset, space, access: viewing.access });
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const accessible = loadAccessibleItem(id, user.id);
  const denied = accessError(accessible?.access ?? null, 'edit');
  if (denied || !accessible) {
    return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });
  }
  const item = accessible.item;

  let body: { title?: string; sortOrder?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: '名称不能为空' }, { status: 400 });
    if (title.length > 200) return NextResponse.json({ error: '名称过长' }, { status: 400 });
    db.prepare('UPDATE space_items SET title = ? WHERE id = ?').run(title, id);
  }

  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder)) {
      return NextResponse.json({ error: '排序值必须是整数' }, { status: 400 });
    }
    db.prepare('UPDATE space_items SET sort_order = ? WHERE id = ?').run(body.sortOrder, id);
  }

  db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(item.space_id);

  return NextResponse.json({
    item: db.prepare('SELECT * FROM space_items WHERE id = ?').get(id) as SpaceItem,
  });
}

/** 从空间移除（不删除图库素材与磁盘文件） */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const accessible = loadAccessibleItem(id, user.id);
  const denied = accessError(accessible?.access ?? null, 'edit');
  if (denied || !accessible) {
    return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });
  }
  const item = accessible.item;

  db.prepare('DELETE FROM space_items WHERE id = ?').run(id);
  db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(item.space_id);

  return NextResponse.json({ ok: true });
}
