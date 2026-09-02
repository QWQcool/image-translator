import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { imageLimiter, storeImage, SUPPORTED_MIME_TYPES } from '@/lib/storage';
import type { Asset } from '@/lib/types';

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const keyword = (params.get('q') ?? '').trim();
  // 开放图库：默认返回全部素材（公共池，已过滤回收站里的软删除素材）。
  // my/shared 保留是为了兼容旧前端书签，语义分别收窄为"我上传的"/"他人上传的"；
  // trash 只返回软删除素材（回收站视图）。
  const scopeParam = params.get('scope');
  const scope =
    scopeParam === 'my' || scopeParam === 'shared' || scopeParam === 'trash'
      ? scopeParam
      : ('all' as const);

  const SELECT = `SELECT a.*, u.username AS owner_username
                    FROM assets a JOIN users u ON u.id = a.owner_id`;
  const FUZZY = `(a.title LIKE ? OR a.original_name LIKE ? OR IFNULL(a.source_author,'') LIKE ?)`;
  const kwArgs = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`];
  const ORDER = `ORDER BY a.created_at DESC, a.id DESC`;
  // 默认只看未删除的；trash 视图只看已删除的
  const LIVE = scope === 'trash' ? 'a.deleted_at IS NOT NULL' : 'a.deleted_at IS NULL';

  let rows: Asset[];
  if (scope === 'my') {
    rows = (
      keyword
        ? db
            .prepare(`${SELECT} WHERE a.owner_id = ? AND ${LIVE} AND ${FUZZY} ${ORDER}`)
            .all(user.id, ...kwArgs)
        : db.prepare(`${SELECT} WHERE a.owner_id = ? AND ${LIVE} ${ORDER}`).all(user.id)
    ) as Asset[];
  } else if (scope === 'shared') {
    rows = (
      keyword
        ? db
            .prepare(`${SELECT} WHERE a.owner_id <> ? AND ${LIVE} AND ${FUZZY} ${ORDER}`)
            .all(user.id, ...kwArgs)
        : db.prepare(`${SELECT} WHERE a.owner_id <> ? AND ${LIVE} ${ORDER}`).all(user.id)
    ) as Asset[];
  } else {
    rows = (
      keyword
        ? db.prepare(`${SELECT} WHERE ${LIVE} AND ${FUZZY} ${ORDER}`).all(...kwArgs)
        : db.prepare(`${SELECT} WHERE ${LIVE} ${ORDER}`).all()
    ) as Asset[];
  }

  return NextResponse.json({ assets: rows });
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
// 单次请求的文件数上限，避免一次请求把服务器内存吃光
const MAX_FILES_PER_REQUEST = 20;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  // 开放图库：上传即进入公共池，所有人可见可用（shared 字段保留只为兼容旧表单）
  const visibility = 'shared';

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return NextResponse.json({ error: '没有收到图片文件' }, { status: 400 });
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `单次最多上传 ${MAX_FILES_PER_REQUEST} 张图片，请分批上传` },
      { status: 400 },
    );
  }

  const created: Asset[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (!SUPPORTED_MIME_TYPES.includes(file.type)) {
      errors.push(`${file.name}：不支持的格式（${file.type || '未知'}）`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}：超过 20MB 限制`);
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const stored = await imageLimiter.run(() => storeImage(buffer, file.type));
      const result = db
        .prepare(
          `INSERT INTO assets
             (owner_id, filename, thumb_filename, original_name, mime_type,
              width, height, size_bytes, title, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user.id,
          stored.filename,
          stored.thumbFilename,
          file.name,
          stored.storedMimeType,
          stored.width,
          stored.height,
          stored.sizeBytes,
          file.name.replace(/\.[^.]+$/, ''),
          visibility,
        );
      created.push(
        db.prepare('SELECT * FROM assets WHERE id = ?').get(result.lastInsertRowid) as Asset,
      );
    } catch (err) {
      errors.push(`${file.name}：${err instanceof Error ? err.message : '处理失败'}`);
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join('；') || '全部图片处理失败' }, { status: 400 });
  }
  logOp(
    user.id,
    'upload',
    'asset',
    null,
    created[0]?.title ?? null,
    `上传 ${created.length} 张图片${created.length > 0 ? `：${created.map((a) => a.title ?? a.original_name ?? `#${a.id}`).join('、').slice(0, 200)}` : ''}`,
  );
  return NextResponse.json({ assets: created, errors }, { status: 201 });
}

/**
 * 批量删除图库图片：软删除（置 deleted_at + 解绑空间引用），磁盘文件保留。
 * 真正清文件走回收站的「彻底删除」。
 */
export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { ids?: number[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const ids = (body.ids ?? []).filter((id) => Number.isInteger(id));
  if (ids.length === 0) {
    return NextResponse.json({ error: '未提供要删除的图片' }, { status: 400 });
  }

  const placeholders = ids.map(() => '?').join(',');
  // 开放图库：任何人都可以清理公共池里的图。这里是软删除，
  // 文件保留在磁盘与图库行里，可从回收站恢复。
  const targets = db
    .prepare(
      `SELECT id, owner_id, title, original_name FROM assets
        WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .all(...ids) as { id: number; owner_id: number; title: string | null; original_name: string | null }[];

  if (targets.length === 0) {
    return NextResponse.json({ error: '图片不存在或已在回收站' }, { status: 404 });
  }

  const targetIds = targets.map((asset) => asset.id);
  const ph2 = targetIds.map(() => '?').join(',');
  // 先统计影响面（解绑后 cascade 会清掉这些行，无法再查）
  const usage = db
    .prepare(`SELECT COUNT(*) AS n FROM space_items WHERE asset_id IN (${ph2})`)
    .get(...targetIds) as { n: number };
  // 解绑空间引用（标注随外键级联删除），素材本身进回收站
  const unbind = db.prepare('DELETE FROM space_items WHERE asset_id = ?');
  const softDelete = db.prepare(
    `UPDATE assets SET deleted_at = datetime('now') WHERE id = ?`,
  );
  db.transaction(() => {
    for (const id of targetIds) {
      unbind.run(id);
      softDelete.run(id);
    }
  })();

  for (const asset of targets) {
    logOp(
      user.id,
      'delete',
      'asset',
      asset.id,
      asset.title ?? asset.original_name ?? `素材 ${asset.id}`,
      '移入回收站',
    );
  }

  return NextResponse.json({
    deleted: targets.length,
    detachedFromSpaces: usage.n,
    notOwned: targets.filter((a) => a.owner_id !== user.id).length,
  });
}
