import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { hardDeleteAssets } from '@/lib/hard-delete';
import { logOp } from '@/lib/oplog';
import { imageLimiter, storeImage, SUPPORTED_MIME_TYPES } from '@/lib/storage';
import type { Asset } from '@/lib/types';

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const keyword = (params.get('q') ?? '').trim();
  // 开放图库：默认返回全部素材（公共池，历史软删除素材继续过滤掉）。
  // my/shared 保留是为了兼容旧前端书签，语义分别收窄为"我上传的"/"他人上传的"。
  const scopeParam = params.get('scope');
  const scope =
    scopeParam === 'my' || scopeParam === 'shared' ? scopeParam : ('all' as const);

  const SELECT = `SELECT a.*, u.username AS owner_username
                    FROM assets a JOIN users u ON u.id = a.owner_id`;
  const FUZZY = `(a.title LIKE ? OR a.original_name LIKE ? OR IFNULL(a.source_author,'') LIKE ?)`;
  const kwArgs = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`];
  const ORDER = `ORDER BY a.created_at DESC, a.id DESC`;
  // 回收站已移除，历史软删除数据依旧不可见
  const LIVE = 'a.deleted_at IS NULL';

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
 * 批量删除图库图片：彻底删除（素材行 + 空间条目 + 标注 + 磁盘文件）。
 * 回收站已移除，删除即删除。
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

  const result = await hardDeleteAssets(ids, user.id);
  if (result.deleted === 0) {
    return NextResponse.json({ error: '图片不存在' }, { status: 404 });
  }

  return NextResponse.json({
    deleted: result.deleted,
    detachedFromSpaces: result.detachedFromSpaces,
  });
}
