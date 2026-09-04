/**
 * 站点配置（site_settings 表）的共享类型、默认值与清洗函数。
 * 纯函数模块（不依赖 db）：服务端 API 与客户端组件共用。
 */
import { PROGRESS_LABEL, SPACE_PROGRESS_VALUES, type SpaceProgress } from './progress';
import { PRESET_TAGS } from './tags';

/** site_settings 表里两个配置项的 key */
export const SETTING_PROGRESS_ITEMS = 'progress_items';
export const SETTING_PRESET_TAGS = 'preset_tags';

/** 进度项配置：key 固定为内置七态（不可增删），label 可改（≤8 字），enabled 控制显隐 */
export type ProgressItem = { key: SpaceProgress; label: string; enabled: boolean };

/** 默认进度项：七态全启用、用内置 label（未配置过 site_settings 时的回落值） */
export const DEFAULT_PROGRESS_ITEMS: ProgressItem[] = SPACE_PROGRESS_VALUES.map((key) => ({
  key,
  label: PROGRESS_LABEL[key],
  enabled: true,
}));

/** 默认预设标签（未配置过 site_settings 时的回落值） */
export const DEFAULT_PRESET_TAGS: readonly string[] = PRESET_TAGS;

/** 进度 label 最大字符数 */
export const MAX_PROGRESS_LABEL_LENGTH = 8;
/** 预设标签上限个数 */
export const MAX_PRESET_TAGS = 30;
/** 预设标签单项最大字符数 */
export const MAX_PRESET_TAG_LENGTH = 12;

/** 进度 label 允许的字符白名单：中英文、数字与少量常用符号（匹配到的为非法字符，清洗时剔除） */
const LABEL_ILLEGAL = /[^一-龥A-Za-z0-9（）()·、\-—]/g;

/** 清洗单个进度 label：剔除非法字符、截断到 8 字，空则回默认 label */
export function cleanProgressLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(LABEL_ILLEGAL, '').trim().slice(0, MAX_PROGRESS_LABEL_LENGTH);
  return cleaned || fallback;
}

/**
 * 清洗进度项配置：key 必须恰好覆盖内置七态（不可增删、不可重复），
 * 缺 label/enabled 的单项用默认补齐。整体不合法返回 null（调用方 400）。
 */
export function cleanProgressItems(raw: unknown): ProgressItem[] | null {
  if (!Array.isArray(raw)) return null;
  const byKey = new Map<string, { label?: unknown; enabled?: unknown }>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const record = item as { key?: unknown; label?: unknown; enabled?: unknown };
    if (typeof record.key !== 'string') return null;
    if (byKey.has(record.key)) return null;
    byKey.set(record.key, { label: record.label, enabled: record.enabled });
  }
  if (byKey.size !== SPACE_PROGRESS_VALUES.length) return null;
  return SPACE_PROGRESS_VALUES.map((key) => {
    const entry = byKey.get(key) ?? {};
    return {
      key,
      label: cleanProgressLabel(entry.label, PROGRESS_LABEL[key]),
      enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
    };
  });
}

/** 清洗预设标签配置：每项 trim、截断 ≤12 字、去空去重、上限 30 个；不合法整体返回 null */
export function cleanPresetTags(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.some((item) => typeof item !== 'string')) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw as string[]) {
    const tag = item.trim().slice(0, MAX_PRESET_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_PRESET_TAGS) break;
  }
  return result;
}

/** 某进度的展示名：配置优先，回落内置 label */
export function progressLabelOf(items: ProgressItem[], key: SpaceProgress): string {
  return items.find((item) => item.key === key)?.label ?? PROGRESS_LABEL[key];
}

/** 已启用的进度项（详情页切换菜单 / 筛选 chips 只列这些） */
export function enabledProgressItems(items: ProgressItem[]): ProgressItem[] {
  return items.filter((item) => item.enabled);
}
