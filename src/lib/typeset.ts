import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './db';

export type TypesetTextLayer = {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  stroke: string;
  strokeWidth: number;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** 隐藏后不参与画布渲染与导出（图层面板的眼睛开关） */
  visible?: boolean;
  /** 竖排文字：从上到下逐字排列（日漫对白刚需） */
  vertical?: boolean;
};

export type TypesetMeta = {
  version: 1;
  width: number;
  height: number;
  textLayers: TypesetTextLayer[];
  updatedAt: string;
};

export function typesetDir(itemId: number): string {
  return path.join(DATA_DIR, 'typeset', String(itemId));
}

export async function readTypesetMeta(itemId: number): Promise<TypesetMeta | null> {
  try {
    const raw = await fs.readFile(path.join(typesetDir(itemId), 'meta.json'), 'utf8');
    return JSON.parse(raw) as TypesetMeta;
  } catch {
    return null;
  }
}

export async function writeTypeset(itemId: number, meta: TypesetMeta, paint?: Buffer | null): Promise<void> {
  const dir = typesetDir(itemId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  if (paint && paint.length > 0) {
    await fs.writeFile(path.join(dir, 'paint.png'), paint);
  }
}

export async function readTypesetPaint(itemId: number): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(typesetDir(itemId), 'paint.png'));
  } catch {
    return null;
  }
}
