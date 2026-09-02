import type { Annotation, LabelPlusGroup } from './types';

export const DEFAULT_LP_GROUPS: LabelPlusGroup[] = [
  { id: 1, name: '框内' },
  { id: 2, name: '框外' },
];

export const DEFAULT_LP_PHRASES = ['……', '（沉默）', '（笑声）'];

/** 1=框内红，2=框外蓝，其余自配 */
export const GROUP_COLORS = [
  '#E85A7A',
  '#3B8BE0',
  '#1F64B8',
  '#E8C547',
  '#7C5CBF',
  '#2AA39A',
  '#E07A3D',
  '#5B8C5A',
  '#C45C9A',
];

export function groupColor(groupId: number): string {
  const index = Math.min(8, Math.max(0, (groupId || 1) - 1));
  return GROUP_COLORS[index] ?? GROUP_COLORS[0];
}

export function parseGroups(raw: string | null | undefined): LabelPlusGroup[] {
  if (!raw) return DEFAULT_LP_GROUPS.map((g) => ({ ...g }));
  try {
    const parsed = JSON.parse(raw) as LabelPlusGroup[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_LP_GROUPS.map((g) => ({ ...g }));
    return parsed
      .filter((g) => Number.isInteger(g.id) && g.id >= 1 && g.id <= 9)
      .slice(0, 9)
      .map((g) => ({ id: g.id, name: String(g.name || `分组${g.id}`).slice(0, 20) }));
  } catch {
    return DEFAULT_LP_GROUPS.map((g) => ({ ...g }));
  }
}

export function parsePhrases(raw: string | null | undefined): string[] {
  if (!raw) return [...DEFAULT_LP_PHRASES];
  try {
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed)) return [...DEFAULT_LP_PHRASES];
    return parsed.map((p) => String(p).slice(0, 80)).filter(Boolean).slice(0, 40);
  } catch {
    return [...DEFAULT_LP_PHRASES];
  }
}

export type LpLabel = { x: number; y: number; groupId: number; text: string };
export type LpFile = { filename: string; labels: LpLabel[] };
export type LpDocument = { groups: string[]; files: LpFile[] };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function parseLabelPlus(text: string): LpDocument {
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  let i = 0;
  if (lines[i] !== undefined) i += 1;
  if (lines[i]?.trim() === '-') i += 1;

  const groups: string[] = [];
  while (i < lines.length && lines[i].trim() !== '-') {
    const name = lines[i].trim();
    if (name) groups.push(name);
    i += 1;
  }
  if (lines[i]?.trim() === '-') i += 1;
  if (i < lines.length) i += 1;

  const files: LpFile[] = [];
  const fileRe = /^>{4,}\[(.+)\]<{4,}\s*$/;
  const labelRe = /^-{8,}\[(\d+)\]-{8,}\[([0-9.]+),([0-9.]+),(\d+)\]\s*$/;
  let current: LpFile | null = null;
  let currentLabel: LpLabel | null = null;

  const flushLabel = () => {
    if (current && currentLabel) {
      current.labels.push({ ...currentLabel, text: currentLabel.text.replace(/\n+$/, '') });
      currentLabel = null;
    }
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const fileMatch = line.match(fileRe);
    if (fileMatch) {
      flushLabel();
      current = { filename: fileMatch[1], labels: [] };
      files.push(current);
      continue;
    }
    const labelMatch = line.match(labelRe);
    if (labelMatch && current) {
      flushLabel();
      currentLabel = {
        x: clamp01(Number(labelMatch[2])),
        y: clamp01(Number(labelMatch[3])),
        groupId: Math.min(9, Math.max(1, Number(labelMatch[4]) || 1)),
        text: '',
      };
      continue;
    }
    if (currentLabel) {
      currentLabel.text += currentLabel.text ? `\n${line}` : line;
    }
  }
  flushLabel();
  return { groups: groups.slice(0, 9), files };
}

export function serializeLabelPlus(doc: {
  groups: LabelPlusGroup[];
  files: { filename: string; labels: LpLabel[] }[];
}): string {
  const names = [...doc.groups]
    .sort((a, b) => a.id - b.id)
    .map((g) => g.name || `分组${g.id}`);
  const groupLines = names.length > 0 ? names : ['框内', '框外'];
  // 头部的「Default Comment」是标题，下一行才是正文，后面还要留两个空行。
  // 少了这两行，LabelPlus / PS 脚本等严格解析器会把第一个 >>>>>>>> 文件标记
  // 当成注释正文吃掉，导致首个文件的标号全部丢失。
  const chunks = ['1,0', '-', ...groupLines, '-', 'Default Comment', 'You can edit me', '', ''];

  for (const file of doc.files) {
    chunks.push(`>>>>>>>>[${file.filename}]<<<<<<<<`);
    file.labels.forEach((label, index) => {
      const x = clamp01(label.x).toFixed(3);
      const y = clamp01(label.y).toFixed(3);
      chunks.push(`----------------[${index + 1}]----------------[${x},${y},${label.groupId}]`);
      chunks.push(label.text || '');
    });
  }

  return `\uFEFF${chunks.join('\r\n')}\r\n`;
}

export function pinsOf(annotations: Annotation[]): Annotation[] {
  return annotations.filter((a) => a.kind === 'pin');
}

export function exportFilename(originalName: string | null, filename: string): string {
  return originalName || filename;
}
