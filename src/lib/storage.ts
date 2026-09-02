import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { DATA_DIR } from './db';

export const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const PREVIEWS_DIR = path.join(DATA_DIR, 'previews');

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export const SUPPORTED_MIME_TYPES = Object.keys(EXT_BY_MIME);

const THUMB_WIDTH = 520;
const PREVIEW_EDGE = 2000;

export type StoredImage = {
  filename: string;
  thumbFilename: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  /** 原文件 MIME，与上传格式一致 */
  storedMimeType: string;
};

function stemOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

export async function ensureImageDirs(): Promise<void> {
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.mkdir(THUMBS_DIR, { recursive: true });
  await fs.mkdir(PREVIEWS_DIR, { recursive: true });
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
 * 落盘一张图片：原文件原样保存，另生成网格缩略图和编辑器用预览图。
 */
export async function storeImage(input: Buffer, mimeType: string): Promise<StoredImage> {
  await ensureImageDirs();
  const ext = EXT_BY_MIME[mimeType];
  if (!ext) {
    throw new Error(`不支持的图片格式: ${mimeType}`);
  }

  const id = crypto.randomUUID();
  const filename = `${id}.${ext}`;
  const thumbFilename = `${id}.webp`;
  const previewFilename = `${id}.webp`;

  await fs.writeFile(path.join(IMAGES_DIR, filename), input);

  const meta = await sharp(input, { animated: false, failOn: 'none' }).rotate().metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  await sharp(input, { animated: false, failOn: 'none' })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toFile(path.join(THUMBS_DIR, thumbFilename));

  try {
    await sharp(input, { animated: false, failOn: 'none' })
      .rotate()
      .resize({
        width: PREVIEW_EDGE,
        height: PREVIEW_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toFile(path.join(PREVIEWS_DIR, previewFilename));
  } catch {
    // 预览图失败不影响原图落盘
  }

  const stat = await fs.stat(path.join(IMAGES_DIR, filename));

  return {
    filename,
    thumbFilename,
    width,
    height,
    sizeBytes: stat.size,
    storedMimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
  };
}

export async function deleteImageFiles(
  filename: string,
  thumbFilename: string | null,
): Promise<void> {
  const stem = stemOf(filename);
  await safeUnlink(path.join(IMAGES_DIR, filename));
  if (thumbFilename) {
    await safeUnlink(path.join(THUMBS_DIR, thumbFilename));
  }
  await safeUnlink(path.join(THUMBS_DIR, `${stem}.webp`));
  await safeUnlink(path.join(PREVIEWS_DIR, `${stem}.webp`));
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // 文件已不存在时忽略
  }
}

export const IMAGE_DIRS = { IMAGES_DIR, THUMBS_DIR, PREVIEWS_DIR };
