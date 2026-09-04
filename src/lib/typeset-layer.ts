import type { TypesetTextLayer } from './typeset';

export type { TypesetTextLayer } from './typeset';

/**
 * 文字层特效/排版字段的纯清洗函数（无 node 依赖，客户端 / 服务端共用）。
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

/** font-family 清洗：只放行常见字体名字符（字母数字/空格/引号/逗号/连字符/中日文字），超长截断、非法回 undefined */
function cleanFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().slice(0, 200);
  if (!text) return undefined;
  return /^[-\w\s.,"'\u3000-\u30ff\u4e00-\u9fff]+$/.test(text) ? text : undefined;
}

/** 渐变填充清洗：from/to 均为合法颜色串才保留对象，否则回 null（= 纯色 color） */
function cleanFillGradient(value: unknown): { from: string; to: string } | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as { from?: unknown; to?: unknown };
  const from = cleanEffectColor(obj.from);
  const to = cleanEffectColor(obj.to);
  return from && to ? { from, to } : null;
}

/**
 * 清洗文字层特效/排版字段（PUT 保存与客户端加载共用，保持协议形状不变）：
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
      width:
        typeof layer.width === 'number' && Number.isFinite(layer.width)
          ? Math.min(1, Math.max(0.05, layer.width))
          : null,
      letterSpacing: clampRatio(layer.letterSpacing, -0.2, 0.5, 0),
      fontFamily: cleanFontFamily(layer.fontFamily),
      tcyEnabled: layer.tcyEnabled === undefined ? true : Boolean(layer.tcyEnabled),
      rotation: clampRatio(layer.rotation, -180, 180, 0),
      scale: clampRatio(layer.scale, 0.2, 4, 1),
      fillGradient: cleanFillGradient(layer.fillGradient),
    } as TypesetTextLayer;
  });
}

// ---- 横排自动断行（避头尾禁则）----

/** 行首禁则字符：这些字符不允许落在一行开头，断行点需要前借（把该字符留在上一行行尾） */
export const LINE_START_FORBIDDEN = '。、，！？…‥』」）〕］｝·ーぁぃぅぇぉっゃゅょャュョッー';

/** 行尾禁则字符：开括号/开引号不允许挂在行尾，断行点需要后移（把开括号推到下一行） */
export const LINE_END_FORBIDDEN = '（「『〔［｛';

/**
 * 横排限宽自动断行（纯函数，预览与导出共用同一份行结果）：
 * - 先按手动 \n 分段（手动断行始终生效）；
 * - 段内逐字符贪心填充，宽度 = measureChar(字符) + letterSpacingPx，超出 maxWidth 折行；
 * - 断行点落禁则字符时前借/后移调整（行首禁则最多前借 1 字符，行尾禁则连续后移）；
 * - 单个字符超宽时至少 1 字符一行，保证收敛。
 */
export function wrapTextWithWidth(
  text: string,
  measureChar: (ch: string) => number,
  maxWidthPx: number,
  letterSpacingPx: number,
): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    const chars = Array.from(paragraph);
    let start = 0;
    while (start < chars.length) {
      let end = start;
      let w = 0;
      while (end < chars.length) {
        const cw = Math.max(0, measureChar(chars[end]) + letterSpacingPx);
        if (end > start && w + cw > maxWidthPx) break;
        w += cw;
        end += 1;
      }
      if (end >= chars.length) {
        out.push(chars.slice(start).join(''));
        break;
      }
      // 避头尾：行首禁则前借一个字符（该字符留在本行行尾）
      if (LINE_START_FORBIDDEN.includes(chars[end])) end += 1;
      // 避头尾：行尾禁则连续后移（开括号推到下一行行首）
      while (end - 1 > start && LINE_END_FORBIDDEN.includes(chars[end - 1])) end -= 1;
      if (end <= start) end = start + 1;
      out.push(chars.slice(start, end).join(''));
      start = end;
    }
  }
  return out;
}

// ---- 竖排纵中横排（半角字符段转正）----

/** 纵中横排：视为「半角字符」的集合（ASCII 数字 + 字母 + 常用半角符号） */
export const TCY_HALF_WIDTH_CHARS = new Set(
  (
    '0123456789' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
    'abcdefghijklmnopqrstuvwxyz' +
    ".-!?\"',:;()~%+"
  ).split(''),
);

/** 竖排逐字布局的最小单元：单个全角字符，或一段连续半角字符（纵中横排段） */
export type VerticalRun =
  | { kind: 'char'; text: string }
  | { kind: 'tcy'; text: string; small: boolean };

/**
 * 把一行文字按「连续半角字符段」分组：
 * - 全角字符逐字成段（kind: 'char'）；
 * - 连续半角字符合成一段（kind: 'tcy'），段长 ≤2 为 small（转正占一格），≥3 横倒占多格。
 */
export function groupVerticalRuns(line: string): VerticalRun[] {
  const runs: VerticalRun[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      runs.push({ kind: 'tcy', text: buf, small: buf.length <= 2 });
      buf = '';
    }
  };
  for (const ch of line) {
    if (TCY_HALF_WIDTH_CHARS.has(ch)) {
      buf += ch;
    } else {
      flush();
      runs.push({ kind: 'char', text: ch });
    }
  }
  flush();
  return runs;
}

/** 文本中是否存在半角字符（判断竖排是否需要走逐格布局） */
export function hasHalfWidthChars(text: string): boolean {
  return Array.from(text).some((ch) => TCY_HALF_WIDTH_CHARS.has(ch));
}
