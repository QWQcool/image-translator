import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR } from './db';

export const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export const SUPPORTED_MIME_TYPES = Object.keys(EXT_BY_MIME);

/** 原图最长边上限。标注用途不需要 4K 原图，这一项直接决定存储成本。 */
const MAX_EDGE = 1800;
const THUMB_WIDTH = 520;

export type StoredImage = {
  filename: string;
  thumbFilename: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  /** 实际落盘的格式，可能与上传格式不同（统一转 WebP） */
  storedMimeType: string;
};

export async function ensureImageDirs(): Promise<void> {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.mkdir(THUMBS_DIR, { recursive: true });
}

/**
 * 并发闸门。sharp 解码大图是内存密集操作，
 * 不限流的话多人同时上传会让进程内存飙升直至 OOM。
 */
export class ConcurrencyLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** 图片处理全局限流：同时最多 2 张在被 sharp 处理 */
export const imageLimiter = new ConcurrencyLimiter(2);

/**
 * 落盘一张图片：压缩原图 + 生成缩略图。
 *
 * 原图统一转为 WebP（GIF 动图除外，保持原格式以免丢失动画），
 * 并限制最长边。实测可把平均体积压到原始 JPEG 的 40~50%，
 * 这是整个方案里性价比最高的存储/流量优化手段。
 */
export async function storeImage(input: Buffer, mimeType: string): Promise<StoredImage> {
  await ensureImageDirs();
  if (!EXT_BY_MIME[mimeType]) {
    throw new Error(`不支持的图片格式: ${mimeType}`);
  }

  const id = crypto.randomUUID();
  const isGif = mimeType === 'image/gif';
  const filename = `${id}.${isGif ? 'gif' : 'webp'}`;
  const thumbFilename = `${id}.webp`;

  const meta = await sharp(input, { animated: false }).metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;

  let width = sourceWidth;
  let height = sourceHeight;
  let storedMimeType: string;

  if (isGif) {
    // 动图不做有损转换，直接落盘原文件
    await fs.writeFile(path.join(IMAGES_DIR, filename), input);
    storedMimeType = 'image/gif';
  } else {
    const pipeline = sharp(input)
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 });
    const output = await pipeline.toBuffer({ resolveWithObject: true });
    await fs.writeFile(path.join(IMAGES_DIR, filename), output.data);
    width = output.info.width;
    height = output.info.height;
    storedMimeType = 'image/webp';
  }

  await sharp(input, { animated: false })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(path.join(THUMBS_DIR, thumbFilename));

  const stat = await fs.stat(path.join(IMAGES_DIR, filename));

  return {
    filename,
    thumbFilename,
    width: width || sourceWidth,
    height: height || sourceHeight,
    sizeBytes: stat.size,
    storedMimeType,
  };
}

export async function deleteImageFiles(
  filename: string,
  thumbFilename: string | null,
): Promise<void> {
  await safeUnlink(path.join(IMAGES_DIR, filename));
  if (thumbFilename) {
    await safeUnlink(path.join(THUMBS_DIR, thumbFilename));
  }
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // 文件已不存在时忽略
  }
}

export const IMAGE_DIRS = { IMAGES_DIR, THUMBS_DIR };
