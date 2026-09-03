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
  /** 富文本分段（JSON 存储）；字段省略 = 继承标注级样式。text 列仍是纯文本冗余 */
  runs?: TextRun[] | null;
  /** 文字不透明度 0~1（默认 1；底色透明度由 bg_color 自己表达） */
  text_opacity?: number | null;
  /** 疑点标记（存疑）：画布 amber 描边 + 面板徽标，随保存/协作链路走 */
  doubtful?: boolean;
  updated_by?: number | null;
  updated_by_username?: string | null;
};

/** 富文本分段：字段省略 = 继承标注级样式 */
export type TextRun = {
  text: string;
  color?: string;
  fontSizeRatio?: number;
  fontWeight?: number;
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
  text_opacity: 1,
  doubtful: false,
};

/** 解析数据库里的 runs JSON（坏数据一律回退 null = 单段继承标注级样式） */
export function parseRuns(raw: unknown): TextRun[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const runs: TextRun[] = [];
    for (const item of parsed) {
      const row = item as { text?: unknown; color?: unknown; fontSizeRatio?: unknown; fontWeight?: unknown };
      if (typeof row.text !== 'string' || row.text === '') continue;
      runs.push({
        text: row.text,
        ...(typeof row.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(row.color)
          ? { color: row.color }
          : {}),
        ...(typeof row.fontSizeRatio === 'number' && Number.isFinite(row.fontSizeRatio)
          ? { fontSizeRatio: row.fontSizeRatio }
          : {}),
        ...(row.fontWeight === 400 || row.fontWeight === 700 ? { fontWeight: row.fontWeight } : {}),
      });
    }
    return runs.length > 0 ? runs : null;
  } catch {
    return null;
  }
}

/** 两个 run 的样式字段是否完全一致（undefined 视为相等） */
function sameStyle(a: TextRun, b: TextRun): boolean {
  return a.color === b.color && a.fontSizeRatio === b.fontSizeRatio && a.fontWeight === b.fontWeight;
}

/**
 * 规范化 runs：合并相邻同款段落、剔除空段。
 * 结果只剩单段且无任何覆盖样式时返回 null（不必存 runs）。
 */
export function normalizeRuns(runs: TextRun[] | null | undefined): TextRun[] | null {
  if (!runs || runs.length === 0) return null;
  const merged: TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = merged[merged.length - 1];
    if (last && sameStyle(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  if (merged.length === 0) return null;
  if (merged.length === 1) {
    const only = merged[0];
    if (only.color === undefined && only.fontSizeRatio === undefined && only.fontWeight === undefined) {
      return null;
    }
  }
  return merged;
}

/**
 * 把样式套用到 [start, end) 选区：按选区边界拆分 run，命中段覆盖样式。
 * 输入 runs 为 null 时视为整段无样式。返回前会做合并规范化。
 */
export function applyRunStyle(
  runs: TextRun[] | null | undefined,
  text: string,
  start: number,
  end: number,
  patch: Partial<Omit<TextRun, 'text'>>,
): TextRun[] {
  const source = runs && runs.length > 0 ? runs : [{ text }];
  const out: TextRun[] = [];
  let pos = 0;
  for (const run of source) {
    const runStart = pos;
    const runEnd = pos + run.text.length;
    pos = runEnd;
    if (runEnd <= start || runStart >= end) {
      out.push({ ...run });
      continue;
    }
    const from = Math.max(start, runStart) - runStart;
    const to = Math.min(end, runEnd) - runStart;
    if (from > 0) out.push({ ...run, text: run.text.slice(0, from) });
    out.push({ ...run, text: run.text.slice(from, to), ...patch });
    if (to < run.text.length) out.push({ ...run, text: run.text.slice(to) });
  }
  return normalizeRuns(out) ?? [{ text }];
}

export function isPin(annotation: { kind?: string; w: number; h: number }): boolean {
  return annotation.kind === 'pin' || (annotation.w <= 0 && annotation.h <= 0 && annotation.kind !== 'box');
}

export const CANVAS_FONT =
  '700 {size}px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 标注的 runs 是否带有覆盖样式（决定画布走富文本排版还是单段快路径） */
export function hasRunOverrides(runs: TextRun[] | null | undefined): boolean {
  if (!runs) return false;
  return runs.some(
    (run) => run.color !== undefined || run.fontSizeRatio !== undefined || run.fontWeight !== undefined,
  );
}

/** 把标注展开成带样式的字符流（runs 字段省略处继承标注级样式） */
export function styledCharsOf(
  annotation: {
    text: string;
    font_size_ratio: number;
    color: string;
    font_weight: number;
    runs?: TextRun[] | null;
  },
  canvasHeight: number,
): Array<{ ch: string; color: string; size: number; weight: number }> {
  const base = Math.max(4, annotation.font_size_ratio * canvasHeight);
  const runs = annotation.runs && annotation.runs.length > 0 ? annotation.runs : [{ text: annotation.text }];
  const chars: Array<{ ch: string; color: string; size: number; weight: number }> = [];
  for (const run of runs) {
    const size = Math.max(4, base * (run.fontSizeRatio ?? 1));
    const weight = run.fontWeight ?? annotation.font_weight;
    const color = run.color ?? annotation.color;
    for (const ch of run.text) chars.push({ ch, color, size, weight });
  }
  return chars;
}

export type StyledLine = {
  chars: Array<{ ch: string; color: string; size: number; weight: number; width: number }>;
  width: number;
  height: number;
};

/**
 * 富文本逐行排版：按框宽逐字符断行（每字符用自己的字号/字重测量），
 * 总高超出框高时整体按 0.92 缩小字号重排，与 layoutText 的收缩策略一致。
 */
export function layoutRunLines(
  ctx: CanvasRenderingContext2D,
  chars: Array<{ ch: string; color: string; size: number; weight: number }>,
  maxWidth: number,
  maxHeight: number,
  fallbackLineHeight: number,
): StyledLine[] {
  let shrink = 1;
  let result: StyledLine[] = [];
  for (let attempt = 0; attempt < 14; attempt += 1) {
    result = [];
    let current: StyledLine['chars'] = [];
    let lineWidth = 0;
    let lineHeight = 0;
    const pushLine = () => {
      result.push({ chars: current, width: lineWidth, height: lineHeight || fallbackLineHeight });
      current = [];
      lineWidth = 0;
      lineHeight = 0;
    };
    for (const char of chars) {
      const size = Math.max(4, char.size * shrink);
      if (char.ch === '\n') {
        pushLine();
        continue;
      }
      ctx.font = CANVAS_FONT.replace('700', String(char.weight)).replace('{size}', String(size));
      const width = ctx.measureText(char.ch).width;
      if (current.length > 0 && lineWidth + width > maxWidth) pushLine();
      current.push({ ...char, size, width });
      lineWidth += width;
      lineHeight = Math.max(lineHeight, size * 1.25);
    }
    pushLine();
    const total = result.reduce((sum, line) => sum + line.height, 0);
    if (total <= maxHeight || shrink <= 0.35) break;
    shrink *= 0.92;
  }
  return result;
}

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
