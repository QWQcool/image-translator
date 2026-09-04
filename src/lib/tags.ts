/** 标签系统常量与清洗工具（前端预设 chips 与服务端清洗共用） */

/** 每个空间最多标签数 */
export const MAX_TAGS = 10;
/** 单个标签最大字符数 */
export const MAX_TAG_LENGTH = 12;

/** 预设标签：新建/编辑表单里直接点选的候选 */
export const PRESET_TAGS = ['纯爱', '鬼畜', 'SM', '傲慢', '雌小鬼'] as const;

/**
 * 清洗用户输入的标签：
 * - 非数组 / 含非字符串元素 → 整体视为非法，回空数组
 * - 逐个 trim、去空串、截断到 MAX_TAG_LENGTH、去重、最多 MAX_TAGS 个
 */
export function cleanTagsInput(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  if (raw.some((item) => typeof item !== 'string')) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw as string[]) {
    const tag = item.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

/** 解析库里存的 tags JSON 字符串；损坏数据静默回空数组 */
export function parseSpaceTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return cleanTagsInput(JSON.parse(raw));
  } catch {
    return [];
  }
}
