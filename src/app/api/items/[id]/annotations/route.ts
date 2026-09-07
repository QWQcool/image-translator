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
  doubtful?: unknown;
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

  let body: { annotations?: IncomingAnnotation[]; baseAnnotations?: IncomingAnnotation[] };
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
      id: Number.isInteger(row.id) && Number(row.id) > 0 ? Number(row.id) : null,
      x,
      y,
      w: kind === 'pin' ? 0 : Math.max(0, Math.min(1 - x, clamp01(row.w))),
      h: kind === 'pin' ? 0 : Math.max(0, Math.min(1 - y, clamp01(row.h))),
      text,
      runs: runsNormalized?.runs ?? null,
      text_opacity: clampOpacity(row.text_opacity),
      doubtful: row.doubtful ? 1 : 0,
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

  /**
   * 三方合并（乐观并发）：客户端提交 baseAnnotations（它加载时的标注快照）时，
   * 逐字段比对「基线 → 服务器现状 → 客户端现状」，解决两人同时编辑同一张图时
   * 「全量替换导致后保存者吃掉先保存者改动」的丢失更新问题：
   * - 客户端改过的字段以客户端为准；没改的字段保留服务器值（协作者的改动不丢）
   * - 双方都改过同一字段：保存者意图优先
   * - 基线里没有的条目（协作者在客户端加载后新建的）若客户端没提交 → 保留
   * - 服务器有、基线有、客户端没有 → 客户端主动删除 → 删除
   * 不带 base（旧客户端 / 脚本调用）时保持原全量替换语义，行为完全不变。
   */
  const baseList = Array.isArray(body.baseAnnotations)
    ? (body.baseAnnotations as Array<IncomingAnnotation>)
    : null;
  const MERGE_FIELDS = [
    'x',
    'y',
    'w',
    'h',
    'text',
    'runs',
    'text_opacity',
    'doubtful',
    'font_size_ratio',
    'color',
    'bg_color',
    'align',
    'font_weight',
    'kind',
    'group_id',
    'source_text',
    'comment',
  ] as const;
  const sameVal = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const clear = db.prepare('DELETE FROM annotations WHERE item_id = ?');
  const insert = db.prepare(
    `INSERT INTO annotations
       (item_id, x, y, w, h, text, runs, text_opacity, doubtful, font_size_ratio, color, bg_color, align, font_weight,
        order_index, kind, group_id, source_text, comment, updated_by)
     VALUES (@item_id, @x, @y, @w, @h, @text, @runs, @text_opacity, @doubtful, @font_size_ratio, @color, @bg_color, @align, @font_weight,
        @order_index, @kind, @group_id, @source_text, @comment, @updated_by)`,
  );
  const updateMerged = db.prepare(
    `UPDATE annotations
        SET x = @x, y = @y, w = @w, h = @h, text = @text, runs = @runs,
            text_opacity = @text_opacity, doubtful = @doubtful, font_size_ratio = @font_size_ratio,
            color = @color, bg_color = @bg_color, align = @align, font_weight = @font_weight,
            order_index = @order_index, kind = @kind, group_id = @group_id,
            source_text = @source_text, comment = @comment, updated_by = @updated_by
      WHERE id = @id`,
  );
  const updateOrder = db.prepare('UPDATE annotations SET order_index = ? WHERE id = ?');
  const deleteById = db.prepare('DELETE FROM annotations WHERE id = ? AND item_id = ?');
  const touch = db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`);

  db.transaction(() => {
    if (baseList === null) {
      // 原语义：全量替换
      clear.run(itemId);
      for (const row of normalized) {
        const { id: _id, ...rest } = row;
        insert.run({ ...rest, item_id: itemId });
      }
    } else {
      const dbRows = db
        .prepare('SELECT * FROM annotations WHERE item_id = ?')
        .all(itemId) as Array<Record<string, unknown>>;
      const dbById = new Map(dbRows.map((r) => [Number(r.id), r]));
      const baseById = new Map(
        baseList
          .filter((r) => Number.isInteger(r.id) && Number(r.id) > 0)
          .map((r) => [Number(r.id), r as unknown as Record<string, unknown>]),
      );
      const incomingIds = new Set(
        normalized.map((r) => r.id).filter((v): v is number => typeof v === 'number'),
      );

      let order = 0;
      for (const row of normalized) {
        const dbRow = row.id != null ? dbById.get(row.id) : undefined;
        const base = row.id != null ? baseById.get(row.id) : undefined;
        if (row.id != null && dbRow && base) {
          // 已有标注：字段级三方合并
          const merged: Record<string, unknown> = {
            id: row.id,
            order_index: order,
            updated_by: user.id,
          };
          let clientTouched = false;
          for (const field of MERGE_FIELDS) {
            const clientVal = (row as unknown as Record<string, unknown>)[field];
            const changed = !sameVal(clientVal, base[field]);
            if (changed) clientTouched = true;
            merged[field] = changed ? clientVal : dbRow[field];
          }
          // 客户端对这条什么都没改：updated_by 保留原编辑者
          if (!clientTouched) merged.updated_by = dbRow.updated_by;
          updateMerged.run(merged as never);
        } else if (row.id != null && dbRow && !base) {
          // 协作者在客户端加载后新建、但客户端又提交了它：没有基线可比，保守保留服务器版本
          updateOrder.run(order, row.id);
        } else {
          // 新标注：插入
          const { id: _id, ...rest } = row;
          insert.run({ ...rest, item_id: itemId, order_index: order });
        }
        order += 1;
      }

      // 删除判定：基线与服务器都有、但客户端没提交 → 客户端删的；
      // 基线没有、客户端也没提交 → 协作者在客户端加载后新建的，保留
      for (const id of dbById.keys()) {
        if (incomingIds.has(id)) continue;
        if (baseById.has(id)) deleteById.run(id, itemId);
      }
    }

    // 制作人员自动填充：若空间「翻译」为空且本次保存了有效译文，自动填入当前用户昵称
    const spaceRow = db.prepare('SELECT translator FROM spaces WHERE id = ?').get(owned.space_id) as
      | { translator: string }
      | undefined;
    if (spaceRow && !spaceRow.translator && normalized.some((r) => r.text.trim().length > 0)) {
      db.prepare(`UPDATE spaces SET translator = ? WHERE id = ?`).run(user.username, owned.space_id);
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
