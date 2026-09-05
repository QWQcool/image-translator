import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { writePsd } from 'ag-psd';
import JSZip from 'jszip';
import sharp from 'sharp';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { IMAGES_DIR } from '@/lib/storage';
import type { Annotation, Asset, Space, SpaceItem } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

const MAX_PSD_TOTAL_BYTES = 1024 * 1024 * 1024; // 1GB

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  if (clean.length >= 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16) / 255 || 0,
      g: parseInt(clean.slice(2, 4), 16) / 255 || 0,
      b: parseInt(clean.slice(4, 6), 16) / 255 || 0,
    };
  }
  return { r: 0, g: 0, b: 0 };
}

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse('Unauthorized', { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const access = getSpaceAccess(spaceId, user.id);
  const denied = accessError(access, 'view');
  if (denied) return denied;

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as Space | undefined;
  if (!space) return new NextResponse('Not Found', { status: 404 });

  // 制作人员自动填充：导出分层 PSD 时，若空间「嵌字」为空，自动填入当前操作人
  if (!space.typesetter) {
    db.prepare('UPDATE spaces SET typesetter = ? WHERE id = ?').run(user.username, spaceId);
  }

  const items = db
    .prepare(
      `SELECT si.id          AS item_id,
              si.space_id    AS item_space_id,
              si.asset_id    AS item_asset_id,
              si.title       AS item_title,
              si.sort_order  AS item_sort_order,
              a.id           AS asset_id,
              a.filename     AS asset_filename,
              a.original_name AS asset_original_name
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.space_id = ?
        ORDER BY si.sort_order, si.id`,
    )
    .all(spaceId) as Array<{
    item_id: number;
    item_space_id: number;
    item_asset_id: number;
    item_title: string | null;
    item_sort_order: number;
    asset_id: number;
    asset_filename: string;
    asset_original_name: string | null;
  }>;

  if (items.length === 0) {
    return NextResponse.json({ error: '空间内没有任何图片条目' }, { status: 400 });
  }

  const zip = new JSZip();
  let generatedCount = 0;
  let accumulatedBytes = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const imagePath = path.join(IMAGES_DIR, item.asset_filename);
    let imageBuffer: Buffer;
    try {
      imageBuffer = await fs.readFile(imagePath);
    } catch {
      continue;
    }

    try {
      const { data, info } = await sharp(imageBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const width = info.width;
      const height = info.height;

      // 提取本页的标注
      const annotations = db
        .prepare('SELECT * FROM annotations WHERE item_id = ? ORDER BY order_index ASC')
        .all(item.item_id) as Annotation[];

      // 构建图层列表
      // 图层 1: 原图背景
      const children: any[] = [
        {
          name: '原图背景',
          imageData: {
            width,
            height,
            data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
          },
        },
      ];

      // 为每个标注创建可编辑文字图层
      for (let anIdx = 0; anIdx < annotations.length; anIdx++) {
        const an = annotations[anIdx];
        const textContent = (an.text || '').trim();
        if (!textContent) continue;

        const fontSize = Math.max(12, Math.round((an.font_size_ratio || 0.035) * height));
        const posX = Math.round(an.x * width);
        // Photoshop 文本锚点一般在基线，向下偏移 1 个字号
        const posY = Math.round(an.y * height + fontSize);

        const colorObj = parseHexColor(an.color || '#000000');

        children.push({
          name: textContent.replace(/[\r\n]+/g, ' ').slice(0, 16) || `台词 ${anIdx + 1}`,
          text: {
            text: textContent,
            transform: [1, 0, 0, 1, posX, posY],
            style: {
              fontSize,
              fillColor: colorObj,
            },
          },
        });
      }

      // 生成原生 PSD 字节
      const psdArrayBuffer = writePsd({
        width,
        height,
        children,
      });

      const psdBuffer = Buffer.from(psdArrayBuffer);
      if (accumulatedBytes + psdBuffer.byteLength > MAX_PSD_TOTAL_BYTES) {
        break;
      }

      const numStr = String(i + 1).padStart(3, '0');
      const psdFileName = `${numStr}_${(item.item_title || 'page').replace(/[\\/:*?"<>|\uD800-\uDBFF\uDC00-\uDFFF]/g, '_')}.psd`;
      zip.file(psdFileName, psdBuffer, { compression: 'STORE' });

      accumulatedBytes += psdBuffer.byteLength;
      generatedCount++;
    } catch {}
  }

  if (generatedCount === 0) {
    return NextResponse.json({ error: '生成分层 PSD 失败' }, { status: 500 });
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 4 },
  });

  const safeSpaceName = space.name.replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const downloadName = `${safeSpaceName}-分层PSD-${stamp}.zip`;

  return new NextResponse(new Uint8Array(zipBuffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    },
  });
}
