/**
 * 自然排序比较器：数字段按数值比较（"2.jpg" < "10.jpg"）。
 *
 * 与 zip 导入建条目（src/app/api/spaces/import-zip/route.ts）同规则：
 * localeCompare + { numeric: true, sensitivity: 'base' }——numeric 让数字段数值化，
 * sensitivity base 忽略大小写与声调差异（"IMG_1.jpg" 与 "img_1.jpg" 视为同级）。
 * 抽成独立纯函数以便单测，且保证「按文件名重排」与导入顺序口径一致。
 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 按文件名自然排序（原地排序引用需自行复制；这里返回新数组不动原列表） */
export function naturalSortBy<T>(rows: T[], keyOf: (row: T) => string | null): T[] {
  // 有名字的（original_name → title 回退链产出非空 key）参与自然排序；
  // 无 key 的条目按「回退当前顺序」语义：保持原相对顺序排在末尾（稳定排序保证）
  const named: Array<{ key: string; row: T }> = [];
  const unnamed: T[] = [];
  for (const row of rows) {
    const key = (keyOf(row) ?? '').trim();
    if (key) named.push({ key, row });
    else unnamed.push(row);
  }
  named.sort((a, b) => naturalCompare(a.key, b.key));
  return [...named.map((entry) => entry.row), ...unnamed];
}
