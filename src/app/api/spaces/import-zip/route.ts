import { NextResponse } from 'next/server';
import { unzipSync } from 'fflate';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { parseGroups, parseLabelPlus } from '@/lib/labelplus';
import { logOp } from '@/lib/oplog';
import { imageLimiter, storeImage } from '@/lib/storage';

const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_IMAGES = 300;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function basenameOf(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: '请上传有效的 ZIP 压缩包' }, { status: 400 });
  }

  if (file.size > MAX_ZIP_BYTES) {
    return NextResponse.json(
      { error: `压缩包过大（超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限）` },
      { status: 400 },
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    const zipBytes = new Uint8Array(await file.arrayBuffer());
    entries = unzipSync(zipBytes);
  } catch {
    return NextResponse.json({ error: 'ZIP 压缩包解压失败，请确认文件是否损坏' }, { status: 400 });
  }

  // 分离图片文件、annotations.json 与 LabelPlus 翻译文本
  const imageEntries: Array<{ fullPath: string; name: string; buffer: Buffer; mime: string }> = [];
  let annotationsJsonRaw: string | null = null;
  let labelPlusTxtRaw: string | null = null;

  for (const [entryPath, data] of Object.entries(entries)) {
    if (entryPath.endsWith('/')) continue;
    const base = basenameOf(entryPath);
    if (!base || base.startsWith('.') || entryPath.includes('__MACOSX/')) continue;

    const lowerBase = base.toLowerCase();
    const ext = (base.split('.').pop() ?? '').toLowerCase();

    if (lowerBase === 'annotations.json') {
      try {
        annotationsJsonRaw = new TextDecoder('utf-8').decode(data);
      } catch {}
      continue;
    }

    if (ext === 'txt' && (lowerBase.includes('翻译') || lowerBase.includes('trans') || lowerBase.includes('label'))) {
      try {
        labelPlusTxtRaw = new TextDecoder('utf-8').decode(data);
      } catch {}
      continue;
    }

    if (ext in MIME_BY_EXT) {
      imageEntries.push({
        fullPath: entryPath,
        name: base,
        buffer: Buffer.from(data),
        mime: MIME_BY_EXT[ext],
      });
    }
  }

  if (imageEntries.length === 0) {
    return NextResponse.json({ error: '压缩包内未找到任何有效漫画图片' }, { status: 400 });
  }

  // 自然排序漫画图片
  imageEntries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );

  const imagesToProcess = imageEntries.slice(0, MAX_IMAGES);

  // 确定空间名称
  const customName = String(form.get('name') ?? '').trim();
  const rawBaseName = file.name.replace(/\.zip$/i, '').trim();
  const spaceName = customName || rawBaseName || '导入工程空间';
  const description = String(form.get('description') ?? '').trim() || '从工程 ZIP 导入恢复';

  // 解析标注信息源
  let nativeExportData: {
    images?: Array<{
      filename?: string;
      originalName?: string;
      annotations?: Array<{
        norm?: { x: number; y: number; w: number; h: number };
        x?: number;
        y?: number;
        w?: number;
        h?: number;
        text?: string;
        fontSizeRatio?: number;
        color?: string;
        background?: string;
        align?: 'left' | 'center' | 'right';
        fontWeight?: number;
        kind?: 'box' | 'pin';
        groupId?: number;
      }>;
    }>;
  } | null = null;

  if (annotationsJsonRaw) {
    try {
      nativeExportData = JSON.parse(annotationsJsonRaw);
    } catch {}
  }

  let lpDoc = labelPlusTxtRaw ? parseLabelPlus(labelPlusTxtRaw) : null;
  const groups = lpDoc && lpDoc.groups.length > 0 ? lpDoc.groups.map((name, i) => ({ id: i + 1, name })) : parseGroups(null);

  // 1. 创建新空间
  const spaceResult = db
    .prepare(
      `INSERT INTO spaces (owner_id, name, description, lp_groups, visibility, status)
       VALUES (?, ?, ?, ?, 'public', 'active')`,
    )
    .run(user.id, spaceName, description, JSON.stringify(groups));
  const spaceId = Number(spaceResult.lastInsertRowid);

  db.prepare(`INSERT OR IGNORE INTO space_members (space_id, user_id, role) VALUES (?, ?, 'owner')`).run(
    spaceId,
    user.id,
  );

  // 2. 批量处理图片落库
  const insertAnnotation = db.prepare(
    `INSERT INTO annotations
       (item_id, x, y, w, h, text, font_size_ratio, color, bg_color, align, font_weight,
        order_index, kind, group_id, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let totalAnnotations = 0;

  for (let i = 0; i < imagesToProcess.length; i++) {
    const item = imagesToProcess[i];
    try {
      const stored = await imageLimiter.run(() => storeImage(item.buffer, item.mime));
      const title = item.name.replace(/\.[^.]+$/, '');

      const { itemId } = db.transaction(() => {
        const assetRes = db
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
            item.name,
            stored.storedMimeType,
            stored.width,
            stored.height,
            stored.sizeBytes,
            title,
            stored.sha256,
          );
        const assetId = Number(assetRes.lastInsertRowid);

        const itemRes = db
          .prepare(`INSERT INTO space_items (space_id, asset_id, title, sort_order) VALUES (?, ?, ?, ?)`)
          .run(spaceId, assetId, title, i + 1);
        return { itemId: Number(itemRes.lastInsertRowid) };
      })();

      // 3. 关联并写入标注
      if (nativeExportData?.images && nativeExportData.images.length > 0) {
        // 优先从 annotations.json 恢复
        const match =
          nativeExportData.images.find(
            (img) =>
              img.filename?.toLowerCase() === item.name.toLowerCase() ||
              img.originalName?.toLowerCase() === item.name.toLowerCase(),
          ) ?? nativeExportData.images[i];

        if (match?.annotations && Array.isArray(match.annotations)) {
          match.annotations.forEach((an, anIndex) => {
            const x = an.norm?.x ?? an.x ?? 0;
            const y = an.norm?.y ?? an.y ?? 0;
            const w = an.norm?.w ?? an.w ?? 0;
            const h = an.norm?.h ?? an.h ?? 0;
            const text = an.text ?? '';
            const kind = an.kind === 'box' || (w > 0 && h > 0) ? 'box' : 'pin';
            insertAnnotation.run(
              itemId,
              x,
              y,
              w,
              h,
              text,
              an.fontSizeRatio ?? 0.035,
              an.color ?? '#FFFFFF',
              an.background ?? '#000000B3',
              an.align ?? 'left',
              an.fontWeight ?? 700,
              anIndex,
              kind,
              an.groupId ?? 1,
              user.id,
            );
            totalAnnotations++;
          });
        }
      } else if (lpDoc && lpDoc.files.length > 0) {
        // 从 LabelPlus 文本恢复
        const key = item.name.toLowerCase();
        const lpFile =
          lpDoc.files.find(
            (f) =>
              f.filename.toLowerCase() === key ||
              f.filename.toLowerCase().replace(/\.[^.]+$/, '') === key.replace(/\.[^.]+$/, ''),
          ) ?? lpDoc.files[i];

        if (lpFile?.labels && Array.isArray(lpFile.labels)) {
          lpFile.labels.forEach((label, labelIndex) => {
            insertAnnotation.run(
              itemId,
              label.x,
              label.y,
              0,
              0,
              label.text,
              0.035,
              '#FFFFFF',
              '#000000B3',
              'left',
              700,
              labelIndex,
              'pin',
              label.groupId || 1,
              user.id,
            );
            totalAnnotations++;
          });
        }
      }
    } catch {}
  }

  logOp(
    user.id,
    'create',
    'space',
    spaceId,
    spaceName,
    `从工程包导入新建空间，导入 ${imagesToProcess.length} 张图片、${totalAnnotations} 条标注`,
  );

  return NextResponse.json(
    {
      success: true,
      spaceId,
      spaceName,
      imageCount: imagesToProcess.length,
      annotationCount: totalAnnotations,
    },
    { status: 201 },
  );
}
