import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { getSpaceAccess } from '@/lib/permissions';
import { IMAGES_DIR } from '@/lib/storage';
import { parseGroups, serializeLabelPlus } from '@/lib/labelplus';
import type { Annotation, Asset, Space, SpaceItem } from '@/lib/types';

/** 打包原图时的体积上限，超过就跳过后面的图，避免把进程内存打爆 */
const MAX_ZIP_IMAGE_BYTES = 800 * 1024 * 1024;

type Params = { params: Promise<{ id: string }> };

type ExportRow = {
  item: SpaceItem;
  asset: Asset;
  annotations: Annotation[];
};

type ExportQueryRow = {
  item_id: number;
  item_space_id: number;
  item_asset_id: number;
  item_title: string | null;
  item_sort_order: number;
  item_created_at: string;
  asset_id: number;
  asset_owner_id: number;
  asset_filename: string;
  asset_thumb_filename: string | null;
  asset_original_name: string | null;
  asset_mime_type: string;
  asset_width: number | null;
  asset_height: number | null;
  asset_size_bytes: number;
  asset_title: string | null;
  asset_source_url: string | null;
  asset_source_author: string | null;
  asset_source_post_id: string | null;
  asset_visibility: string;
  asset_created_at: string;
};

const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeExportName(name: string): string {
  const cleaned = name.replace(ILLEGAL_CHARS, '_').trim();
  return cleaned || 'image';
}

function buildExportFilenames(rows: ExportRow[]): string[] {
  const result: string[] = [];
  const counts = new Map<string, number>();

  for (const { asset } of rows) {
    const raw = sanitizeExportName(asset.original_name || asset.filename);
    const ext = path.extname(raw);
    const base = ext ? raw.slice(0, -ext.length) : raw;
    const seen = counts.get(raw) ?? 0;
    counts.set(raw, seen + 1);

    const finalName = seen === 0 ? raw : `${base}_${seen + 1}${ext}`;
    result.push(finalName);
  }

  return result;
}

function buildPayload(space: Space, rows: ExportRow[], exportFilenames: string[]) {
  return {
    schema: 'twitter-image-translator/export@1',
    exportedAt: new Date().toISOString(),
    space: {
      id: space.id,
      name: space.name,
      description: space.description,
      createdAt: space.created_at,
      updatedAt: space.updated_at,
    },
    images: rows.map(({ item, asset, annotations }, index) => {
      const width = asset.width ?? 0;
      const height = asset.height ?? 0;
      const exportName = exportFilenames[index] || asset.original_name || asset.filename;
      return {
        itemId: item.id,
        title: item.title ?? '',
        file: `images/${exportName}`,
        filename: exportName,
        originalName: asset.original_name,
        sourceUrl: asset.source_url,
        sourceAuthor: asset.source_author,
        width,
        height,
        annotations: annotations.map((an, index) => ({
          index: index + 1,
          norm: { x: round(an.x), y: round(an.y), w: round(an.w), h: round(an.h) },
          pixel: {
            x: Math.round(an.x * width),
            y: Math.round(an.y * height),
            w: Math.round(an.w * width),
            h: Math.round(an.h * height),
          },
          text: an.text,
          fontSize: Math.round(an.font_size_ratio * height),
          fontSizeRatio: round(an.font_size_ratio),
          color: an.color,
          background: an.bg_color,
          align: an.align,
          fontWeight: an.font_weight,
        })),
      };
    }),
  };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = [
  '图片序号',
  '图片命名',
  '文件名',
  '作者',
  '原图链接',
  '图片宽',
  '图片高',
  '标注序号',
  '文字内容',
  'X(比例)',
  'Y(比例)',
  '宽(比例)',
  '高(比例)',
  'X(像素)',
  'Y(像素)',
  '宽(像素)',
  '高(像素)',
  '字号',
  '文字颜色',
  '背景色',
];

function buildCsv(rows: ExportRow[], exportFilenames: string[]): string {
  const lines: string[] = [CSV_HEADER.join(',')];
  rows.forEach(({ item, asset, annotations }, imageIndex) => {
    const width = asset.width ?? 0;
    const height = asset.height ?? 0;
    const exportName = exportFilenames[imageIndex] || asset.original_name || asset.filename;
    if (annotations.length === 0) {
      lines.push(
        [
          imageIndex + 1,
          item.title ?? '',
          exportName,
          asset.source_author ?? '',
          asset.source_url ?? '',
          width,
          height,
          '', '', '', '', '', '', '', '', '', '', '', '', '',
        ]
          .map(csvCell)
          .join(','),
      );
      return;
    }
    annotations.forEach((an, index) => {
      lines.push(
        [
          imageIndex + 1,
          item.title ?? '',
          exportName,
          asset.source_author ?? '',
          asset.source_url ?? '',
          width,
          height,
          index + 1,
          an.text,
          round(an.x),
          round(an.y),
          round(an.w),
          round(an.h),
          Math.round(an.x * width),
          Math.round(an.y * height),
          Math.round(an.w * width),
          Math.round(an.h * height),
          Math.round(an.font_size_ratio * height),
          an.color,
          an.bg_color,
        ]
          .map(csvCell)
          .join(','),
      );
    });
  });
  // BOM 让 Excel 正确识别 UTF-8 中文
  return `\uFEFF${lines.join('\r\n')}`;
}

function disposition(filename: string): string {
  return `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse('Unauthorized', { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  // 导出属于「查看」范畴，viewer 也能导出
  if (!getSpaceAccess(spaceId, user.id)) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(spaceId) as Space | undefined;
  if (!space) return new NextResponse('Not Found', { status: 404 });

  // 显式列出别名：si.* 与 a.* 存在 id / title / created_at 同名列，
  // 直接 SELECT 会造成后者覆盖前者，必须逐列重命名。
  const items = db
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
              a.created_at   AS asset_created_at
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.space_id = ?
        ORDER BY si.sort_order, si.id`,
    )
    .all(spaceId) as ExportQueryRow[];

  const rows: ExportRow[] = items.map((row) => {
    const asset: Asset = {
      id: row.asset_id,
      owner_id: row.asset_owner_id,
      filename: row.asset_filename,
      thumb_filename: row.asset_thumb_filename,
      original_name: row.asset_original_name,
      mime_type: row.asset_mime_type,
      width: row.asset_width,
      height: row.asset_height,
      size_bytes: row.asset_size_bytes,
      title: row.asset_title,
      source_url: row.asset_source_url,
      source_author: row.asset_source_author,
      source_post_id: row.asset_source_post_id,
      visibility: row.asset_visibility as Asset['visibility'],
      created_at: row.asset_created_at,
    };
    const item: SpaceItem = {
      id: row.item_id,
      space_id: row.item_space_id,
      asset_id: row.item_asset_id,
      title: row.item_title,
      sort_order: row.item_sort_order,
      created_at: row.item_created_at,
    };
    const annotations = db
      .prepare('SELECT * FROM annotations WHERE item_id = ? ORDER BY order_index, id')
      .all(item.id) as Annotation[];
    return { item, asset, annotations };
  });

  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  const safeName = space.name.replace(/[\\/:*?"<>|]/g, '_');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const exportFilenames = buildExportFilenames(rows);

  if (format === 'csv') {
    return new NextResponse(buildCsv(rows, exportFilenames), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': disposition(`${safeName}-标注-${stamp}.csv`),
      },
    });
  }

  const json = JSON.stringify(buildPayload(space, rows, exportFilenames), null, 2);

  const labelPlusTxt = serializeLabelPlus({
    groups: parseGroups(space.lp_groups),
    files: rows.map(({ annotations }, index) => ({
      filename: exportFilenames[index],
      labels: annotations
        .filter((an) => an.kind === 'pin')
        .map((an) => ({ x: an.x, y: an.y, groupId: an.group_id || 1, text: an.text })),
    })),
  });

  if (format === 'lp' || format === 'labelplus') {
    return new NextResponse(labelPlusTxt, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': disposition(`${safeName}-翻译_0.txt`),
      },
    });
  }

  if (format === 'zip') {
    const includeImages = new URL(request.url).searchParams.get('images') !== '0';
    const zip = new JSZip();
    zip.file('annotations.json', json);
    zip.file('annotations.csv', buildCsv(rows, exportFilenames));

    // 图片放 images/，与 annotations.json 里的 file 字段对应，解包即可直接用
    const packed: string[] = [];
    const missing: string[] = [];
    let packedBytes = 0;
    let capped = false;

    if (includeImages) {
      const imageFolder = zip.folder('images') ?? zip;
      for (let i = 0; i < rows.length; i++) {
        const { asset } = rows[i];
        const exportName = exportFilenames[i];
        if (packed.includes(exportName)) continue;
        try {
          const file = await fs.readFile(path.join(IMAGES_DIR, asset.filename));
          if (packedBytes + file.byteLength > MAX_ZIP_IMAGE_BYTES) {
            capped = true;
            continue;
          }
          // 图片本身已压缩，再 deflate 只会白烧 CPU
          imageFolder.file(exportName, file, { compression: 'STORE' });
          packed.push(exportName);
          packedBytes += file.byteLength;
        } catch {
          missing.push(exportName);
        }
      }
      // 翻译_0.txt 写入 images/ 文件夹，与图片在同一文件夹下，根目录不再保留重复文件
      imageFolder.file('翻译_0.txt', labelPlusTxt);
    } else {
      // 未打包图片时，翻译_0.txt 放在 zip 根目录
      zip.file('翻译_0.txt', labelPlusTxt);
    }

    zip.file(
      'README.txt',
      [
        `空间：${space.name}`,
        `导出时间：${new Date().toISOString()}`,
        `图片数量：${rows.length}`,
        `标注数量：${rows.reduce((sum, r) => sum + r.annotations.length, 0)}`,
        '',
        '目录结构：',
        '  annotations.json —— 完整结构，坐标同时提供 0~1 归一化值与像素值。',
        '  annotations.csv  —— 表格形式，可直接用 Excel 打开。',
        includeImages
          ? '  images/          —— 原图文件与同目录下的 翻译_0.txt（PS-Script 可直接读取）。'
          : '  翻译_0.txt       —— LabelPlus 格式译文，PS-Script 可直接读取。',
        '',
        '坐标说明：x/y 为框左上角，w/h 为框宽高，均相对图片左上角。',
        '',
        includeImages
          ? `已打包原图：${packed.length} 个，共 ${(packedBytes / 1024 / 1024).toFixed(1)} MB。`
          : '本次未打包原图（images=0）。',
        capped ? `注意：原图总体积超过 ${MAX_ZIP_IMAGE_BYTES / 1024 / 1024} MB 上限，超出部分未打包。` : '',
        missing.length > 0 ? `注意：${missing.length} 个文件在磁盘上已缺失：${missing.join('、')}` : '',
      ]
        .filter((line) => line !== '')
        .join('\r\n'),
    );

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': disposition(`${safeName}-标注-${stamp}.zip`),
      },
    });
  }

  return new NextResponse(json, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': disposition(`${safeName}-标注-${stamp}.json`),
    },
  });
}
