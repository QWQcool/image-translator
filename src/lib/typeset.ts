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
  // ---- 文字特效（逐层可选，老数据缺省 = 无特效，零迁移）----
  // 注意：新描边字段与旧版 style 预设写入的 stroke/strokeWidth（px）并存互不干扰，
  // strokeColor 非空时新描边生效（宽度按字号比例），为 null 时回落旧的 px 描边行为。
  /** 描边颜色（CSS 颜色串，null = 无描边） */
  strokeColor?: string | null;
  /** 描边宽度，相对字号比例 0~0.5，缺省 0.12；仅 strokeColor 非空时生效 */
  strokeWidthRatio?: number;
  /** 阴影颜色（CSS 颜色串，null = 无阴影） */
  shadowColor?: string | null;
  /** 阴影模糊，相对字号比例 0~0.5，缺省 0.15 */
  shadowBlurRatio?: number;
  /** 阴影偏移，相对字号比例 -0.5~0.5，缺省 { x: 0, y: 0.06 } */
  shadowOffset?: { x: number; y: number };
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

// 特效字段清洗是纯函数（客户端也要用），实现在无 node 依赖的 typeset-layer.ts，
// 这里 re-export 供服务端 route 使用。
export { normalizeTextLayers } from './typeset-layer';

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
