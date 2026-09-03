import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { hardDeleteItems } from '@/lib/hard-delete';
import { normalizeGlossaryInput, normalizeStyles } from '@/lib/labelplus';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import type { Asset, Space, SpaceItem, SpaceStatus, SpaceVisibility } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const access = getSpaceAccess(id, user.id);
  const denied = accessError(access, 'view');
  if (denied) return denied;

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined;
  if (!space) return NextResponse.json({ error: '空间不存在' }, { status: 404 });

  // 空间内搜索：LIKE 匹配条目标题 / 素材原始文件名
  const keyword = (new URL(request.url).searchParams.get('q') ?? '').trim();
  const searchClause = keyword
    ? 'AND (IFNULL(si.title, \'\') LIKE ? OR IFNULL(a.original_name, \'\') LIKE ?)'
    : '';
  const searchArgs = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];

  const items = db
    .prepare(
      `SELECT si.*,
              (SELECT COUNT(*) FROM annotations an WHERE an.item_id = si.id) AS annotation_count,
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
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.space_id = ? ${searchClause}
        ORDER BY si.sort_order, si.id`,
    )
    .all(id, ...searchArgs) as Array<
    SpaceItem & {
      annotation_count: number;
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

  const mapped: SpaceItem[] = items.map((row) => ({
    id: row.id,
    space_id: row.space_id,
    asset_id: row.asset_id,
    title: row.title,
    sort_order: row.sort_order,
    created_at: row.created_at,
    annotation_count: row.annotation_count,
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

  const memberCount = db
    .prepare('SELECT COUNT(*) AS n FROM space_members WHERE space_id = ?')
    .get(id) as { n: number };

  return NextResponse.json({
    space,
    items: mapped,
    access,
    memberCount: memberCount.n,
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  // 先解析 body 才能决定权限级别：分组表是公共工作数据（和标注同级），
  // 开放空间下人人可改；改名/描述/可见性仍然只有创建者能动。
  let body: {
    name?: string;
    description?: string;
    visibility?: string;
    status?: string;
    lp_groups?: Array<{ id: number; name: string }>;
    lp_styles?: Record<string, unknown>;
    lp_glossary?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const wantsManage =
    body.name !== undefined || body.description !== undefined || body.visibility !== undefined;

  const access = getSpaceAccess(id, user.id);
  const denied = accessError(access, wantsManage ? 'manage' : 'edit');
  if (denied) return denied;

  const name = body.name === undefined ? undefined : body.name.trim();
  if (name !== undefined && !name) {
    return NextResponse.json({ error: '空间名称不能为空' }, { status: 400 });
  }
  if (name !== undefined && name.length > 100) {
    return NextResponse.json({ error: '空间名称过长' }, { status: 400 });
  }
  const description = body.description === undefined ? undefined : body.description.trim() || null;
  // 开放空间模型：不再接受 private
  const visibility: SpaceVisibility | undefined =
    body.visibility === 'public' ? 'public' : undefined;

  // 完结状态：登录即可改（扁平权限，轻操作）；非法取值直接拒绝
  const status: SpaceStatus | undefined =
    body.status === 'active' || body.status === 'finished' ? body.status : undefined;
  if (body.status !== undefined && status === undefined) {
    return NextResponse.json({ error: 'status 只能是 active 或 finished' }, { status: 400 });
  }

  // LabelPlus 分组表：1~9 组，名字留空的组视为停用
  let lpGroupsJson: string | null | undefined;
  if (body.lp_groups !== undefined) {
    if (!Array.isArray(body.lp_groups)) {
      return NextResponse.json({ error: 'lp_groups 必须是数组' }, { status: 400 });
    }
    const cleaned = body.lp_groups
      .filter(
        (g) =>
          g &&
          Number.isInteger(g.id) &&
          g.id >= 1 &&
          g.id <= 9 &&
          typeof g.name === 'string' &&
          g.name.trim(),
      )
      .slice(0, 9)
      .map((g) => ({ id: g.id, name: g.name.trim().slice(0, 20) }));
    lpGroupsJson = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
  }

  // 嵌字分组样式预设：与 lp_groups 同级（公共工作数据），edit 级权限即可修改
  let lpStylesJson: string | null | undefined;
  if (body.lp_styles !== undefined) {
    if (typeof body.lp_styles !== 'object' || body.lp_styles === null || Array.isArray(body.lp_styles)) {
      return NextResponse.json({ error: 'lp_styles 必须是对象' }, { status: 400 });
    }
    // normalizeStyles 只保留 1~9 的合法分组键并清洗字段
    lpStylesJson = JSON.stringify(normalizeStyles(body.lp_styles));
  }

  // 术语表：与 lp_groups 同级（公共工作数据），edit 级权限即可修改；
  // 显式传空数组 = 清空，与 lp_groups 的「留空停用」语义不同
  let lpGlossaryJson: string | null | undefined;
  if (body.lp_glossary !== undefined) {
    if (!Array.isArray(body.lp_glossary)) {
      return NextResponse.json({ error: 'lp_glossary 必须是数组' }, { status: 400 });
    }
    lpGlossaryJson = JSON.stringify(normalizeGlossaryInput(body.lp_glossary));
  }

  if (
    name === undefined &&
    description === undefined &&
    visibility === undefined &&
    status === undefined &&
    lpGroupsJson === undefined &&
    lpStylesJson === undefined &&
    lpGlossaryJson === undefined
  ) {
    return NextResponse.json({ error: '没有需要更新的字段' }, { status: 400 });
  }

  db.prepare(
    `UPDATE spaces
        SET name = COALESCE(?, name),
            description = COALESCE(?, description),
            visibility = COALESCE(?, visibility),
            status = COALESCE(?, status),
            lp_groups = COALESCE(?, lp_groups),
            lp_styles = COALESCE(?, lp_styles),
            lp_glossary = COALESCE(?, lp_glossary),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(name ?? null, description ?? null, visibility ?? null, status ?? null, lpGroupsJson ?? null, lpStylesJson ?? null, lpGlossaryJson ?? null, id);

  // 日志：只记管理类改动（名称/描述/可见性/完结状态），分组表与样式的编辑很频繁，不刷屏
  const changed: string[] = [];
  if (name !== undefined) changed.push('名称');
  if (description !== undefined) changed.push('描述');
  if (visibility !== undefined) changed.push('可见性');
  if (status !== undefined) changed.push(status === 'finished' ? '标记完结' : '重新开启');
  if (changed.length > 0) {
    const current = db.prepare('SELECT name FROM spaces WHERE id = ?').get(id) as { name: string };
    logOp(user.id, 'update', 'space', id, current.name, `修改空间${changed.join('、')}`);
  }

  return NextResponse.json({
    space: db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space,
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const access = getSpaceAccess(id, user.id);
  const denied = accessError(access, 'manage');
  if (denied) return denied;

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(id) as
    | { name: string }
    | undefined;

  // 删除即删除：先彻底删除空间内全部条目（标注与不再被引用的素材文件一并清理），
  // 再删空间行。被其它空间共用的素材会自动保留。
  const itemIds = db
    .prepare('SELECT id FROM space_items WHERE space_id = ?')
    .all(id) as Array<{ id: number }>;
  if (itemIds.length > 0) {
    await hardDeleteItems(
      itemIds.map((row) => row.id),
      user.id,
    );
  }

  db.prepare('DELETE FROM spaces WHERE id = ?').run(id);

  logOp(user.id, 'space_delete', 'space', id, space?.name ?? `空间 ${id}`);

  return NextResponse.json({ ok: true });
}
