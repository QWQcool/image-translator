import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from './db';

/** 头像目录：data/avatars（data/ 已在 .gitignore） */
export function avatarDir(): string {
  return path.join(DATA_DIR, 'avatars');
}

/**
 * 保存头像：统一转成 256x256 WebP 方形（cover 裁切），
 * 文件名用随机串避免路径猜测；返回文件名。
 */
export async function saveAvatar(userId: number, buffer: Buffer): Promise<string> {
  const dir = avatarDir();
  await fs.mkdir(dir, { recursive: true });
  const filename = `${userId}-${Date.now().toString(36)}.webp`;
  await sharp(buffer)
    .rotate()
    .resize(256, 256, { fit: 'cover', position: 'attention' })
    .webp({ quality: 88 })
    .toFile(path.join(dir, filename));
  return filename;
}

export async function readAvatar(filename: string): Promise<Buffer | null> {
  // 文件名是我们自己生成的，但仍然挡掉任何路径分隔符
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return null;
  try {
    return await fs.readFile(path.join(avatarDir(), filename));
  } catch {
    return null;
  }
}

/** 换头像后把旧文件删掉，防止垃圾堆积 */
export async function deleteAvatar(filename: string | null): Promise<void> {
  if (!filename) return;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return;
  try {
    await fs.unlink(path.join(avatarDir(), filename));
  } catch {
    // 旧文件不存在就算了
  }
}
