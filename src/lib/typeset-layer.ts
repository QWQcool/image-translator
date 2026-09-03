import type { TypesetTextLayer } from './typeset';

export type { TypesetTextLayer } from './typeset';

/**
 * 文字层特效字段的纯清洗函数（无 node 依赖，客户端 / 服务端共用）。
 * 单独成文件是因为 typeset.ts 依赖 better-sqlite3，客户端组件不能直接引。
 */

/** 颜色串清洗：只接受 #hex / rgb() / rgba() 常见形态，超长截断、非法回 null */
function cleanEffectColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 32);
  return /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/i.test(text) ? text : null;
}

/** 数字 clamp：非法回落缺省值 */
function clampRatio(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * 清洗文字层特效字段（PUT 保存与客户端加载共用，保持协议形状不变）：
 * 颜色非法回 null（= 无特效），数字 clamp 到合法区间，缺省值与字段注释一致。
 * 其它既有字段原样透传（与旧版保存行为一致，不额外校验）。
 */
export function normalizeTextLayers(layers: unknown): TypesetTextLayer[] {
  if (!Array.isArray(layers)) return [];
  return layers.slice(0, 200).map((raw) => {
    const layer = (raw ?? {}) as Partial<TypesetTextLayer> & Record<string, unknown>;
    const offset = (layer.shadowOffset ?? {}) as { x?: unknown; y?: unknown };
    return {
      ...layer,
      strokeColor: cleanEffectColor(layer.strokeColor),
      strokeWidthRatio: clampRatio(layer.strokeWidthRatio, 0, 0.5, 0.12),
      shadowColor: cleanEffectColor(layer.shadowColor),
      shadowBlurRatio: clampRatio(layer.shadowBlurRatio, 0, 0.5, 0.15),
      shadowOffset: {
        x: clampRatio(offset.x, -0.5, 0.5, 0),
        y: clampRatio(offset.y, -0.5, 0.5, 0.06),
      },
    } as TypesetTextLayer;
  });
}
