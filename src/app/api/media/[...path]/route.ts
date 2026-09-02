import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { IMAGE_DIRS } from '@/lib/storage';

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const KIND_DIR: Record<string, string> = {
  original: IMAGE_DIRS.IMAGES_DIR,
  images: IMAGE_DIRS.IMAGES_DIR,
  thumb: IMAGE_DIRS.THUMBS_DIR,
  thumbs: IMAGE_DIRS.THUMBS_DIR,
  preview: IMAGE_DIRS.PREVIEWS_DIR,
  previews: IMAGE_DIRS.PREVIEWS_DIR,
};

/**
 * 图片文件服务。走 API 路由而非 public 目录，因为运行时上传的文件
 * 在 Next.js 生产模式下不会被 public 静态服务识别。
 *
 * 路由：/api/media/{original|thumb|preview}/<filename>
 * 旧路径 images/ thumbs/ 仍可用。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!(await getCurrentUser())) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { path: segments } = await params;
  if (!Array.isArray(segments) || segments.length !== 2) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const [kind, filename] = segments;
  const baseDir = KIND_DIR[kind];
  if (!baseDir) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // 阻断路径穿越
  if (filename.includes('..') || path.isAbsolute(filename)) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const filePath = path.join(baseDir, filename);
  // 二次校验：解析后必须仍在目标目录内
  if (!filePath.startsWith(baseDir + path.sep)) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return new NextResponse('Not Found', { status: 404 });
  }

  const contentType = MIME_MAP[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';

  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
