import { NextResponse } from 'next/server';
import { unzipSync } from 'fflate';
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
// 压缩包整体体积上限
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
// 一个压缩包最多创建的条目数
const MAX_ZIP_ENTRIES = 200;

// 压缩包内允许的图片扩展名 → MIME（按扩展名判定，zip 条目没有真实 MIME）
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** 取路径的 basename，防止压缩包里的相对路径写到目录外 */
function basenameOf(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/**
 * 直接向空间上传图片：每张图创建一个素材（公共池）+ 一个条目，追加到空间末尾。
 * 上传 .zip 压缩包时自动解包，按自然排序把里面的图片逐张导入（整话上传）。
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
  const skipped: Array<{ name: string; reason: string }> = [];
  const duplicates: Array<{ fileName: string; spaceName: string; itemTitle: string; spaceId: number }> = [];
  const errors: string[] = [];

  // 单张图片的「buffer→asset→item」创建路径：直传与 zip 解包共用，保证 order_index 接在空间末尾
  const createItem = async (buffer: Buffer, originalName: string, mimeType: string) => {
    const stored = await imageLimiter.run(() => storeImage(buffer, mimeType));
    const title = originalName.replace(/\.[^.]+$/, '');

    // 图源查重：若该图片已存在于其他空间，记录提示信息
    if (stored.sha256) {
      const dup = db
        .prepare(
          `SELECT s.id AS spaceId, s.name AS spaceName, si.title AS itemTitle
             FROM assets a
             JOIN space_items si ON si.asset_id = a.id
             JOIN spaces s ON s.id = si.space_id
            WHERE a.sha256 = ? AND a.deleted_at IS NULL AND s.id != ?
            LIMIT 1`,
        )
        .get(stored.sha256, spaceId) as
        | { spaceId: number; spaceName: string; itemTitle: string }
        | undefined;
      if (dup) {
        duplicates.push({
          fileName: originalName,
          spaceName: dup.spaceName,
          itemTitle: dup.itemTitle,
          spaceId: dup.spaceId,
        });
      }
    }

    // 素材与条目必须同事务落库，避免出现孤儿素材或半截条目
    const ids = db.transaction(() => {
      const assetResult = db
        .prepare(
          `INSERT INTO assets
             (owner_id, filename, thumb_filename, original_name, mime_type,
              width, height, size_bytes, title, visibility, sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'shared', ?)`,
        )
        .run(
          user.id,
          stored.filename,
          stored.thumbFilename,
          originalName,
          stored.storedMimeType,
          stored.width,
          stored.height,
          stored.sizeBytes,
          title,
          stored.sha256,
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
  };

  for (const file of files) {
    // ---- 压缩包：解包后逐张导入 ----
    if (file.name.toLowerCase().endsWith('.zip')) {
      if (file.size > MAX_ZIP_BYTES) {
        errors.push(`${file.name}：压缩包超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 限制`);
        continue;
      }

      let entries: Record<string, Uint8Array>;
      try {
        const zipBytes = new Uint8Array(await file.arrayBuffer());
        entries = unzipSync(zipBytes, {
          filter: (f) => {
            const name = f.name;
            // 目录项与 macOS 压缩产物直接忽略（记入 skipped 供前端提示）
            if (name.endsWith('/')) return false;
            const base = basenameOf(name);
            if (!base) return false;
            if (name.includes('__MACOSX/') || base.startsWith('.')) {
              skipped.push({ name: base, reason: '压缩包系统产物 / 隐藏文件' });
              return false;
            }
            const ext = (base.split('.').pop() ?? '').toLowerCase();
            if (!(ext in MIME_BY_EXT)) {
              skipped.push({ name: base, reason: '非图片文件' });
              return false;
            }
            // 是图片但超过单图体积限制：记入 skipped 后排除
            if (f.size > MAX_FILE_BYTES) {
              skipped.push({ name: base, reason: '单图超过 20MB 限制' });
              return false;
            }
            return true;
          },
        });
      } catch {
        errors.push(`${file.name}：zip 解包失败`);
        continue;
      }

      // 自然排序决定导入顺序（1.jpg / 2.jpg / 10.jpg）
      const names = Object.keys(entries).sort((a, b) =>
        basenameOf(a).localeCompare(basenameOf(b), undefined, { numeric: true }),
      );

      for (const name of names) {
        const base = basenameOf(name);
        if (created.length >= MAX_ZIP_ENTRIES) {
          skipped.push({ name: base, reason: '超过单次 200 个条目上限' });
          continue;
        }
        const ext = (base.split('.').pop() ?? '').toLowerCase();
        try {
          await createItem(Buffer.from(entries[name]), base, MIME_BY_EXT[ext]);
        } catch (err) {
          skipped.push({
            name: base,
            reason: err instanceof Error ? err.message : '处理失败',
          });
        }
      }
      continue;
    }

    // ---- 普通图片直传 ----
    if (!SUPPORTED_MIME_TYPES.includes(file.type)) {
      errors.push(`${file.name}：不支持的格式（${file.type || '未知'}）`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}：超过 20MB 限制`);
      continue;
    }

    try {
      await createItem(Buffer.from(await file.arrayBuffer()), file.name, file.type);
    } catch (err) {
      errors.push(`${file.name}：${err instanceof Error ? err.message : '处理失败'}`);
    }
  }

  if (created.length === 0) {
    return NextResponse.json(
      { error: errors.join('；') || '全部图片处理失败', skipped },
      { status: 400 },
    );
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

  return NextResponse.json({ items, added: created.length, created, skipped, duplicates, errors }, { status: 201 });
}
