import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { imageLimiter, storeImage, SUPPORTED_MIME_TYPES } from '@/lib/storage';
import type { SpaceItem } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const MAX_FILE_BYTES = 20 * 1024 * 1024;
// 单次请求的文件数上限，避免一次请求把服务器内存吃光
const MAX_FILES_PER_REQUEST = 20;

/**
 * 直接向空间上传图片：每张图创建一个素材（公共池）+ 一个条目，追加到空间末尾。
 * 图库已并入空间，这是新的唯一上传入口。
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  // 往空间里加图片属于「改」，viewer 不允许
  const denied = accessError(getSpaceAccess(spaceId, user.id), 'edit');
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

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

  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM space_items WHERE space_id = ?')
    .get(spaceId) as { m: number };
  let nextOrder = maxOrder.m + 1;

  const created: Array<{ itemId: number; assetId: number; title: string }> = [];
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
      const title = file.name.replace(/\.[^.]+$/, '');

      // 素材与条目必须同事务落库，避免出现孤儿素材或半截条目
      const ids = db.transaction(() => {
        const assetResult = db
          .prepare(
            `INSERT INTO assets
               (owner_id, filename, thumb_filename, original_name, mime_type,
                width, height, size_bytes, title, visibility)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'shared')`,
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
            title,
          );
        const assetId = Number(assetResult.lastInsertRowid);
        const itemResult = db
          .prepare(
            `INSERT INTO space_items (space_id, asset_id, title, sort_order)
             VALUES (?, ?, ?, ?)`,
          )
          .run(spaceId, assetId, title, nextOrder++);
        return { assetId, itemId: Number(itemResult.lastInsertRowid) };
      })();
      created.push({ ...ids, title });
    } catch (err) {
      errors.push(`${file.name}：${err instanceof Error ? err.message : '处理失败'}`);
    }
  }

  if (created.length === 0) {
    return NextResponse.json({ error: errors.join('；') || '全部图片处理失败' }, { status: 400 });
  }

  db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(spaceId);

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(spaceId) as
    | { name: string }
    | undefined;
  logOp(
    user.id,
    'upload',
    'asset',
    created[0].assetId,
    created[0].title,
    `向空间「${space?.name ?? spaceId}」上传 ${created.length} 张图片：${created
      .map((c) => c.title)
      .join('、')
      .slice(0, 200)}`,
  );

  const items = db
    .prepare('SELECT * FROM space_items WHERE space_id = ? ORDER BY sort_order, id')
    .all(spaceId) as SpaceItem[];

  return NextResponse.json({ items, added: created.length, errors }, { status: 201 });
}
