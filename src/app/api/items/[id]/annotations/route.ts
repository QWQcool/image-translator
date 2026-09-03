import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { saveGuard } from '@/lib/room';
import type { Annotation } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(itemId) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'view');
  if (denied) return denied;

  const annotations = db
    .prepare(
      `SELECT a.*, u.username AS updated_by_username
         FROM annotations a
         LEFT JOIN users u ON u.id = a.updated_by
        WHERE a.item_id = ?
        ORDER BY a.order_index, a.id`,
    )
    .all(itemId) as Annotation[];

  return NextResponse.json({ annotations });
}

type IncomingAnnotation = {
  id?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  font_size_ratio: number;
  color: string;
  bg_color: string;
  align: 'left' | 'center' | 'right';
  font_weight: number;
  kind?: 'box' | 'pin';
  group_id?: number;
  source_text?: string;
  comment?: string;
  runs?: unknown;
  text_opacity?: unknown;
};

const ALIGNS = new Set(['left', 'center', 'right']);

/**
 * 规范化富文本分段：校验颜色/字号倍率(0.5~2)/粗细，合并相邻同款。
 * 全默认（单段无覆盖）时返回 null，runs 列不存；text 由 runs 拼接（纯文本冗余）。
 */
function normalizeRunsInput(raw: unknown): { runs: string | null; text: string } | null {
  let list: unknown[];
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      list = parsed;
    } catch {
      return null;
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return null;
  }

  const merged: Array<{ text: string; color?: string; fontSizeRatio?: number; fontWeight?: number }> = [];
  for (const item of list) {
    const row = item as { text?: unknown; color?: unknown; fontSizeRatio?: unknown; fontWeight?: unknown };
    if (typeof row.text !== 'string' || row.text === '') continue;
    const run = {
      text: row.text,
      ...(typeof row.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(row.color)
        ? { color: row.color }
        : {}),
      ...(typeof row.fontSizeRatio === 'number' && Number.isFinite(row.fontSizeRatio)
        ? { fontSizeRatio: Math.min(2, Math.max(0.5, row.fontSizeRatio)) }
        : {}),
      ...(row.fontWeight === 400 || row.fontWeight === 700 ? { fontWeight: row.fontWeight } : {}),
    };
    const last = merged[merged.length - 1];
    if (
      last &&
      last.color === run.color &&
      last.fontSizeRatio === run.fontSizeRatio &&
      last.fontWeight === run.fontWeight
    ) {
      last.text += run.text;
    } else {
      merged.push(run);
    }
  }
  if (merged.length === 0) return null;
  const allDefault = merged.every(
    (r) => r.color === undefined && r.fontSizeRatio === undefined && r.fontWeight === undefined,
  );
  if (allDefault) return { runs: null, text: merged.map((r) => r.text).join('') };
  return { runs: JSON.stringify(merged), text: merged.map((r) => r.text).join('') };
}

function clampOpacity(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.min(1, Math.max(0, num));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 全量保存：客户端把编辑器当前的全部标注一次性提交，服务端在事务内整体替换 */
export async function PUT(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  // 协作锁：别人持锁且未共享时不允许覆盖
  const guard = saveGuard(itemId, user.id);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: 423 });
  }

  const item = db.prepare('SELECT space_id FROM space_items WHERE id = ?').get(itemId) as
    | { space_id: number }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'edit');
  if (denied) return denied;
  if (!item) return NextResponse.json({ error: '条目不存在' }, { status: 404 });
  const owned = item;

  let body: { annotations?: IncomingAnnotation[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const incoming = body.annotations ?? [];
  if (!Array.isArray(incoming)) {
    return NextResponse.json({ error: 'annotations 必须是数组' }, { status: 400 });
  }

  const normalized = incoming.map((row, index) => {
    const x = clamp01(row.x);
    const y = clamp01(row.y);
    const kind = row.kind === 'pin' ? 'pin' : 'box';
    const groupId = Number.isInteger(row.group_id) ? Math.min(9, Math.max(1, Number(row.group_id))) : 1;
    const runsNormalized = normalizeRunsInput(row.runs);
    const text = runsNormalized ? runsNormalized.text : String(row.text ?? '');
    return {
      x,
      y,
      w: kind === 'pin' ? 0 : Math.max(0, Math.min(1 - x, clamp01(row.w))),
      h: kind === 'pin' ? 0 : Math.max(0, Math.min(1 - y, clamp01(row.h))),
      text,
      runs: runsNormalized?.runs ?? null,
      text_opacity: clampOpacity(row.text_opacity),
      font_size_ratio: Math.min(0.5, Math.max(0.004, Number(row.font_size_ratio) || 0.035)),
      color: /^#[0-9a-fA-F]{6}$/.test(row.color ?? '') ? row.color : '#FFFFFF',
      bg_color: /^#[0-9a-fA-F]{8}$|^#[0-9a-fA-F]{6}$/.test(row.bg_color ?? '')
        ? row.bg_color
        : '#000000B3',
      align: ALIGNS.has(row.align) ? row.align : 'left',
      font_weight: row.font_weight === 400 ? 400 : 700,
      order_index: index,
      kind,
      group_id: groupId,
      source_text: String(row.source_text ?? ''),
      comment: String(row.comment ?? ''),
      updated_by: user.id,
    };
  });

  const clear = db.prepare('DELETE FROM annotations WHERE item_id = ?');
  const insert = db.prepare(
    `INSERT INTO annotations
       (item_id, x, y, w, h, text, runs, text_opacity, font_size_ratio, color, bg_color, align, font_weight,
        order_index, kind, group_id, source_text, comment, updated_by)
     VALUES (@item_id, @x, @y, @w, @h, @text, @runs, @text_opacity, @font_size_ratio, @color, @bg_color, @align, @font_weight,
        @order_index, @kind, @group_id, @source_text, @comment, @updated_by)`,
  );
  const touch = db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`);

  db.transaction(() => {
    clear.run(itemId);
    for (const row of normalized) {
      insert.run({ ...row, item_id: itemId });
    }
    touch.run(owned.space_id);
  })();

  const itemName = itemDisplayName(itemId);
  logOp(user.id, 'update', 'item', itemId, itemName, `标注保存（${normalized.length} 条）`);

  const annotations = db
    .prepare(
      `SELECT a.*, u.username AS updated_by_username
         FROM annotations a
         LEFT JOIN users u ON u.id = a.updated_by
        WHERE a.item_id = ?
        ORDER BY a.order_index, a.id`,
    )
    .all(itemId) as Annotation[];

  return NextResponse.json({ annotations });
}
