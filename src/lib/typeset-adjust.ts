/**
 * 嵌字「背景调整」参数与 LUT 计算（客户端/服务端共用，无 node 依赖）。
 *
 * 设计要点：
 * - 非破坏：参数只存进嵌字草稿 meta.adjust，绝不改原图/涂改层/文字层数据；
 *   导出时仅对背景层应用 LUT（涂改层笔迹、文字层颜色不应被调）。
 * - 预览与导出同一套曲线：本模块的 computeAdjustLut 是唯一曲线来源，
 *   预览用 SVG feComponentTransfer 的 tableValues 精确复现 LUT（GPU 加速、拖滑条不掉帧），
 *   导出用 canvas 逐像素查表，两端逐像素一致。
 */

export type TypesetAdjust = {
  /** 亮度倍率 0.5~1.5，缺省 1 */
  brightness: number;
  /** 对比度倍率 0.5~1.5（线性，绕 0.5 中点拉伸），缺省 1 */
  contrast: number;
  /** 黑场 0~0.3（低于该亮度直接压到 0），缺省 0 */
  blackPoint: number;
  /** 白场 0.7~1（高于该亮度直接抬到 1），缺省 1 */
  whitePoint: number;
  /** gamma 0.5~2（中间调：>1 提亮、<1 压暗），缺省 1 */
  gamma: number;
};

export const DEFAULT_ADJUST: TypesetAdjust = {
  brightness: 1,
  contrast: 1,
  blackPoint: 0,
  whitePoint: 1,
  gamma: 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 逐字段 clamp，非法值（含 null/非数字）回落默认；老 meta 无 adjust = 全默认（零迁移） */
export function normalizeAdjust(raw: unknown): TypesetAdjust {
  const r = (raw ?? {}) as Partial<Record<keyof TypesetAdjust, unknown>>;
  const num = (v: unknown, fallback: number, min: number, max: number): number => {
    // null/undefined 视为「未设置」直接回落默认（Number(null) 是 0，不能让它 clamp 到下限）
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  return {
    brightness: num(r.brightness, 1, 0.5, 1.5),
    contrast: num(r.contrast, 1, 0.5, 1.5),
    blackPoint: num(r.blackPoint, 0, 0, 0.3),
    whitePoint: num(r.whitePoint, 1, 0.7, 1),
    gamma: num(r.gamma, 1, 0.5, 2),
  };
}

/** 全默认 = 不产生任何像素差异，调用方据此跳过 LUT 处理 */
export function isDefaultAdjust(a: TypesetAdjust): boolean {
  return (
    a.brightness === 1 && a.contrast === 1 && a.blackPoint === 0 && a.whitePoint === 1 && a.gamma === 1
  );
}

/**
 * 色阶 + 亮度/对比度合成单条 256 项 LUT（R/G/B 同曲线，不做分通道）：
 *   x = (in - black) / (white - black)   黑白场拉伸（先于 gamma，PS 色阶同序）
 *   x = x ^ (1/gamma)                    gamma（中间调）
 *   x = x * brightness                   亮度（乘法）
 *   x = (x - 0.5) * contrast + 0.5       对比度（绕中点线性拉伸）
 * 输入域/输出域均 [0,1]，逐值 clamp。全默认时 LUT 恒等。
 */
export function computeAdjustLut(adjust: TypesetAdjust): Uint8Array {
  const a = normalizeAdjust(adjust);
  const black = Math.min(a.blackPoint, a.whitePoint - 0.01); // 防御 black>=white：保底留 1% 区间避免除零
  const white = a.whitePoint;
  const range = Math.max(0.01, white - black);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) {
    let x = v / 255;
    x = clamp((x - black) / range, 0, 1);
    x = Math.pow(x, 1 / a.gamma);
    x *= a.brightness;
    x = (x - 0.5) * a.contrast + 0.5;
    lut[v] = Math.round(clamp(x, 0, 1) * 255);
  }
  return lut;
}

/**
 * 把 LUT 应用到画布 ImageData（只改 RGB，不动 alpha——涂改层/文字层不走这里）。
 * 供编辑器导出 PNG / PSD 背景层使用；调用方先判断 isDefaultAdjust 跳过恒等处理。
 */
export function applyLutToImageData(data: Uint8ClampedArray, lut: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

/**
 * LUT → SVG feComponentTransfer 的 tableValues 串（256 项空格分隔）。
 * type="table" 对相邻表值做线性插值，256 项时与逐像素查表逐位一致；
 * 使用方必须把 filter 设为 colorInterpolationFilters="sRGB"（默认 linearRGB 会改变曲线）。
 * ⚠️ SVG tableValues 必须是 0~1 浮点——直接拼 0~255 整数会让插值溢出（任何非黑
 * 像素被钳到 1），预览整体变白（v0.2.5 实测 bug）。
 */
export function lutToTableValues(lut: Uint8Array): string {
  return Array.from(lut, (v) => (v / 255).toFixed(6)).join(' ');
}
