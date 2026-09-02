export type DraftAnnotation = {
  /** 本地唯一标识，新建的标注还没有服务端 id */
  key: string;
  id?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** 字号 = font_size_ratio × 图片高度 */
  font_size_ratio: number;
  color: string;
  /** 8 位 hex，末两位为透明度 */
  bg_color: string;
  align: 'left' | 'center' | 'right';
  font_weight: number;
  kind: 'box' | 'pin';
  group_id: number;
  source_text: string;
  comment: string;
  updated_by?: number | null;
  updated_by_username?: string | null;
};

export const DEFAULT_ANNOTATION: Omit<DraftAnnotation, 'key' | 'x' | 'y' | 'w' | 'h'> = {
  text: '',
  font_size_ratio: 0.035,
  color: '#FFFFFF',
  bg_color: '#000000B3',
  align: 'left',
  font_weight: 700,
  kind: 'box',
  group_id: 1,
  source_text: '',
  comment: '',
};

export function isPin(annotation: { kind?: string; w: number; h: number }): boolean {
  return annotation.kind === 'pin' || (annotation.w <= 0 && annotation.h <= 0 && annotation.kind !== 'box');
}

export const CANVAS_FONT =
  '700 {size}px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

let keySeed = 0;
export function newKey(): string {
  keySeed += 1;
  return `k${Date.now().toString(36)}-${keySeed}`;
}

/** 把 8 位 hex 拆成色值与透明度，供 <input type="color"> 使用 */
export function splitBgColor(bg: string): { hex: string; alpha: number } {
  const value = bg.replace('#', '');
  if (value.length === 8) {
    return { hex: `#${value.slice(0, 6)}`, alpha: parseInt(value.slice(6, 8), 16) / 255 };
  }
  return { hex: `#${value.padEnd(6, '0').slice(0, 6)}`, alpha: 1 };
}

export function mergeBgColor(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`.toUpperCase();
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 在画布坐标系内排版文本：按框宽逐字符断行（中文无空格，必须按字断），
 * 并在总高超出框高时自动缩小字号，保证译文始终可读。
 */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontWeight: number,
  startFontSize: number,
  maxHeight: number,
): { lines: string[]; fontSize: number; lineHeight: number } {
  let fontSize = Math.max(4, startFontSize);
  let lines: string[] = [];
  let lineHeight = fontSize * 1.25;

  for (let attempt = 0; attempt < 14; attempt += 1) {
    ctx.font = CANVAS_FONT.replace('700', String(fontWeight)).replace('{size}', String(fontSize));
    lines = [];
    for (const paragraph of text.split('\n')) {
      if (paragraph === '') {
        lines.push('');
        continue;
      }
      let line = '';
      for (const char of paragraph) {
        const candidate = line + char;
        if (line !== '' && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = char;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    lineHeight = fontSize * 1.25;
    if (lines.length * lineHeight <= maxHeight || fontSize <= 6) break;
    fontSize *= 0.92;
  }

  return { lines, fontSize, lineHeight };
}
