import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { parseGroups } from '@/lib/labelplus';
import type { Annotation, Space } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

type ItemRow = {
  item_id: number;
  asset_original_name: string | null;
  asset_filename: string;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * LabelPlus 官方 txt 导出（PS 嵌字脚本兼容）。
 * 格式对照 LabelPlus/PS-Script 的 text_parser.ts：
 *   块1 版本 `1.0,1.0` / 块2 分组名 / 块3 注释，均以单独一行 `-` 分隔；
 *   每张图 `>>>>>>[文件名]<<<<<<` 头行，标号 `------[序号]------[x,y,组号]`（x/y 为中心点归一化坐标，4 位小数），
 *   译文逐行紧跟标号头；文本空时用 source_text 兜底，两者都空跳过该标号。
 * 图片与标号顺序均按 order_index，标号序号在图内从 1 递增。
 */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  // 导出属于「查看」范畴，viewer 也可以导出
  const denied = accessError(getSpaceAccess(id, user.id), 'view');
  if (denied) return denied;

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined;
  if (!space) return NextResponse.json({ error: '空间不存在' }, { status: 404 });

  const items = db
    .prepare(
      `SELECT si.id            AS item_id,
              a.original_name  AS asset_original_name,
              a.filename       AS asset_filename
         FROM space_items si
         JOIN assets a ON a.id = si.asset_id
        WHERE si.space_id = ?
        ORDER BY si.sort_order, si.id`,
    )
    .all(id) as ItemRow[];

  const lines: string[] = [];

  // 块1：版本（逗号分隔两个数字）
  lines.push('1.0,1.0', '-');

  // 块2：分组名列表，每行一个，顺序即 1-based 组号；只导出有名字的组
  const groups = parseGroups(space.lp_groups).filter((g) => g.name.trim().length > 0);
  for (const group of groups) lines.push(group.name);
  lines.push('-');

  // 块3：注释（空间名 + 生成说明，可多行）
  lines.push(`空间：${space.name}`);
  lines.push('由 image-translator 导出的 LabelPlus 文本，PS 嵌字脚本按文件名匹配 PSD 图层。');
  lines.push(`导出时间：${new Date().toISOString()}`);
  lines.push('-');

  const selectPins = db.prepare(
    `SELECT * FROM annotations WHERE item_id = ? AND kind = 'pin' ORDER BY order_index, id`,
  );

  for (const item of items) {
    // 文件名用 original_name ?? filename，PS 脚本按文件名顺序匹配图层
    const filename = item.asset_original_name || item.asset_filename;
    lines.push(`>>>>>>[${filename}]<<<<<<`);

    const pins = selectPins.all(item.item_id) as Annotation[];

    let index = 1;
    for (const pin of pins) {
      const text = (pin.text ?? '').trim().length > 0 ? pin.text : pin.source_text;
      // 译文与原文都为空的标号不导出
      if (!text || text.trim().length === 0) continue;
      const x = clamp01(pin.x).toFixed(4);
      const y = clamp01(pin.y).toFixed(4);
      const groupId = pin.group_id || 1;
      lines.push(`------[${index}]------[${x},${y},${groupId}]`);
      // 多行文本直接逐行写，脚本按行累积、首尾 trim
      for (const line of text.replace(/\r\n/g, '\n').split('\n')) lines.push(line);
      index += 1;
    }
  }

  // BOM 让 PS 脚本 / Windows 文本工具正确识别 UTF-8
  const body = `\uFEFF${lines.join('\r\n')}\r\n`;

  const safeName = space.name.replace(/[\\/:*?"<>|]/g, '_');
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="labelplus-txt"; filename*=UTF-8''${encodeURIComponent(
        `${safeName}.txt`,
      )}`,
    },
  });
}
