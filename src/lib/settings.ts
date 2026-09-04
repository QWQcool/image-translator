/**
 * site_settings 表读写（阶段 16）：站点级键值配置，value 以 JSON 序列化存储。
 * 目前承载 progress_items（进度项管理）与 preset_tags（默认标签管理）。
 * 未配置过/数据损坏时全部回落内置默认（老数据零迁移）。
 */
import { db } from './db';
import {
  DEFAULT_PRESET_TAGS,
  DEFAULT_PROGRESS_ITEMS,
  SETTING_PRESET_TAGS,
  SETTING_PROGRESS_ITEMS,
  cleanPresetTags,
  cleanProgressItems,
  type ProgressItem,
} from './site-config';

/** 读取原始配置；行不存在或表尚未迁移（异常）时回落 fallback */
export function getSetting(key: string, fallback: string): string {
  try {
    const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

/** 写入配置（JSON 序列化）；UPSERT 幂等 */
export function setSetting(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO site_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}

/** 读 JSON 配置；序列化/解析失败时静默回 fallback */
export function getJsonSetting<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(getSetting(key, JSON.stringify(fallback))) as T;
  } catch {
    return fallback;
  }
}

/** 进度项配置（未配置过 → 内置七态全启用默认） */
export function getProgressItems(): ProgressItem[] {
  const raw = getJsonSetting<unknown>(SETTING_PROGRESS_ITEMS, DEFAULT_PROGRESS_ITEMS);
  return cleanProgressItems(raw) ?? DEFAULT_PROGRESS_ITEMS;
}

/** 预设标签配置（未配置过 → PRESET_TAGS 默认） */
export function getPresetTags(): string[] {
  const raw = getJsonSetting<unknown>(SETTING_PRESET_TAGS, DEFAULT_PRESET_TAGS);
  return cleanPresetTags(raw) ?? [...DEFAULT_PRESET_TAGS];
}

/**
 * 保存两个配置项：清洗校验后落库。返回清洗结果，
 * 任一项不合法则整体不写入（调用方 400）。
 */
export function saveSiteConfig(
  progressItemsRaw: unknown,
  presetTagsRaw: unknown,
): { progressItems: ProgressItem[] | null; presetTags: string[] | null } {
  const progressItems = cleanProgressItems(progressItemsRaw);
  const presetTags = cleanPresetTags(presetTagsRaw);
  if (progressItems && presetTags) {
    setSetting(SETTING_PROGRESS_ITEMS, progressItems);
    setSetting(SETTING_PRESET_TAGS, presetTags);
  }
  return { progressItems, presetTags };
}
