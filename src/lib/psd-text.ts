/**
 * PSD 原生 TypeTool 文本图层构造（嵌字页导出与 psd-zip 空间批量导出共用，勿复制两份）。
 *
 * ag-psd 的 Layer.text（LayerTextData）写出的文本层在 PS 打开后可直接编辑文字（无需逐层栅格化）：
 * - 映射：字号 / 填充色 / 假粗体 / 行距 / 字距 / 描边色 / 横竖排（orientation）/ 对齐（justification）/ 旋转（transform 矩阵）；
 * - 不映射：渐变填充、阴影、纵中横排（PS 文本引擎无对应单层表达）——调用方对这些层走栅格兜底（混合输出）；
 * - 描边宽度：PSD 文本样式的描边宽度不是公开可移植字段，仅映射颜色（PS 端默认宽度，可再手调）。
 */

import type { Layer, LayerTextData, TextStyle } from 'ag-psd';

export type PsdTextAlign = 'left' | 'center' | 'right';

export type PsdTextInput = {
  /** 图层名（PS 图层面板显示） */
  name: string;
  /** 文本内容（含最终换行；限宽断行由调用方写死进文本，PS 内仍可编辑） */
  text: string;
  /** 字号 px（调用方先乘好整体缩放） */
  fontSize: number;
  /** 填充色 #RRGGBB */
  color: string;
  /** 假粗体（PSD 假粗体不依赖具体字重的字体文件，兼容性最好） */
  bold?: boolean;
  /** 行距 px（缺省不写，落 PS 自动行距） */
  leadingPx?: number;
  /** 字距，单位 1/1000 em（缺省不写） */
  tracking?: number;
  /** 描边色 #RRGGBB（仅颜色；缺省不写） */
  strokeColor?: string | null;
  /** 竖排（PS 直排文字） */
  vertical?: boolean;
  /** 顺时针旋转角度（度，绕文本原点） */
  rotationDeg?: number;
  /** 对齐（映射 PS 段落 justification；横排 point text 的原点语义与对齐联动） */
  align?: PsdTextAlign;
  /**
   * 文本原点（PSD px）：
   * - 横排 = 对齐锚点（left=行左端 / center=行中心 / right=行右端）× 首行基线 y；
   * - 竖排 = 首列基线 x × 文本顶部 y。
   */
  x: number;
  y: number;
  /** 字体名（PS 端缺字时自动替换，不影响可编辑性；缺省不写） */
  fontName?: string;
};

/** #RRGGBB → ag-psd Color（0~1 分量）；防御式清洗：非法形态回落黑色 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
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

/** 构造原生 TypeTool 文本图层 */
export function buildPsdTextLayer(input: PsdTextInput): Layer {
  // 旋转矩阵（顺时针，屏幕 y 向下）：[xx, xy, yx, yy, tx, ty]，与 canvas rotate 同构
  const theta = ((input.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const style: TextStyle = {
    fontSize: input.fontSize,
    fillColor: parseHexColor(input.color),
  };
  if (input.bold) style.fauxBold = true;
  if (input.leadingPx && input.leadingPx > 0) style.leading = input.leadingPx;
  if (input.tracking) style.tracking = Math.round(input.tracking);
  if (input.strokeColor) style.strokeColor = parseHexColor(input.strokeColor);
  if (input.fontName) style.font = { name: input.fontName };

  const text: LayerTextData = {
    text: input.text,
    transform: [cos, sin, -sin, cos, input.x, input.y],
    style,
    orientation: input.vertical ? 'vertical' : 'horizontal',
  };
  // justification 缺省即左对齐，不写字段（与 psd-zip 原行为零差异）
  if (input.align && input.align !== 'left') {
    text.paragraphStyle = { justification: input.align };
  }
  return { name: input.name, text };
}
