import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { deleteImageFiles, imageLimiter, storeImage, SUPPORTED_MIME_TYPES } from '@/lib/storage';
import type { Asset } from '@/lib/types';

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const keyword = (params.get('q') ?? '').trim();
  // 开放图库：默认返回全部素材（公共池）。
  // my/shared 保留是为了兼容旧前端书签，语义分别收窄为"我上传的"/"他人上传的"。
  const scopeParam = params.get('scope');
  const scope =
    scopeParam === 'my' || scopeParam === 'shared' ? scopeParam : ('all' as const);

  const SELECT = `SELECT a.*, u.username AS owner_username
                    FROM assets a JOIN users u ON u.id = a.owner_id`;
  const FUZZY = `(a.title LIKE ? OR a.original_name LIKE ? OR IFNULL(a.source_author,'') LIKE ?)`;
  const kwArgs = [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`];
  const ORDER = `ORDER BY a.created_at DESC, a.id DESC`;

  let rows: Asset[];
  if (scope === 'my') {
    rows = (
      keyword
        ? db
            .prepare(`${SELECT} WHERE a.owner_id = ? AND ${FUZZY} ${ORDER}`)
            .all(user.id, ...kwArgs)
        : db.prepare(`${SELECT} WHERE a.owner_id = ? ${ORDER}`).all(user.id)
    ) as Asset[];
  } else if (scope === 'shared') {
    rows = (
      keyword
        ? db.prepare(`${SELECT} WHERE a.owner_id <> ? AND ${FUZZY} ${ORDER}`).all(user.id, ...kwArgs)
        : db.prepare(`${SELECT} WHERE a.owner_id <> ? ${ORDER}`).all(user.id)
    ) as Asset[];
  } else {
    rows = (
      keyword
        ? db.prepare(`${SELECT} WHERE ${FUZZY} ${ORDER}`).all(...kwArgs)
        : db.prepare(`${SELECT} ${ORDER}`).all()
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
  return NextResponse.json({ assets: created, errors }, { status: 201 });
}

/** 批量删除图库图片（同时解绑空间引用并清理磁盘文件） */
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
  // 开放图库：任何人都可以清理公共池里的图。删除是硬删除（文件一起删），
  // 所以响应里带回"被多少个文件夹引用"，前端用它做二次确认。
  const targets = db
    .prepare(`SELECT id, owner_id, filename, thumb_filename FROM assets WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number; owner_id: number; filename: string; thumb_filename: string | null }[];

  // 删除会级联清掉所有空间里的引用，先算出来告诉用户影响面
  const usage =
    targets.length > 0
      ? (db
          .prepare(`SELECT COUNT(*) AS n FROM space_items WHERE asset_id IN (${placeholders})`)
          .get(...targets.map((asset) => asset.id)) as { n: number })
      : { n: 0 };

  const deleteRow = db.prepare('DELETE FROM assets WHERE id = ?');
  db.transaction(() => {
    for (const asset of targets) deleteRow.run(asset.id);
  })();

  // 外键 ON DELETE CASCADE 已清理 space_items 与 annotations
  await Promise.all(targets.map((a) => deleteImageFiles(a.filename, a.thumb_filename)));

  return NextResponse.json({
    deleted: targets.length,
    detachedFromSpaces: usage.n,
    notOwned: targets.filter((a) => a.owner_id !== user.id).length,
  });
}
