import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

/** 防御上限：超大空间只按页序扫描前 5000 页（正常漫画话数远小于此值） */
const MAX_SCAN = 5000;

/**
 * 「继续工作」定位接口：按页序（sort_order）找 after 之后第一个符合工作状态的页；
 * after 之后没有则从头绕回（wrap）；全空间都没有符合的页返回 { itemId: null }。
 *
 * 返回形状：200 + { itemId: number | null }（不用 204，前端统一走 res.json() 更简单）。
 * after 缺省或不在本空间时，从第一页开始找（宽容处理，不报错）。
 */
export async function GET(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const spaceId = Number((await params).id);
  if (!Number.isInteger(spaceId) || spaceId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(spaceId, user.id), 'view');
  if (denied) return denied;

  const url = new URL(request.url);

  // type 白名单校验：非法直接 400（跳转目标由调用方决定，猜不出来）
  const type = url.searchParams.get('type');
  if (type !== 'untranslated' && type !== 'untypeset') {
    return NextResponse.json({ error: 'type 只能是 untranslated 或 untypeset' }, { status: 400 });
  }

  const rawAfter = Number(url.searchParams.get('after'));
  const after = Number.isInteger(rawAfter) && rawAfter > 0 ? rawAfter : null;

  const rows = db
    .prepare(
      `SELECT si.id,
              si.sort_order,
              (SELECT COUNT(*) FROM annotations anp WHERE anp.item_id = si.id AND anp.kind = 'pin') AS pins_count,
              (SELECT COUNT(*) FROM annotations ant WHERE ant.item_id = si.id AND ant.kind = 'pin' AND IFNULL(ant.text, '') != '') AS pins_with_text,
              CASE WHEN EXISTS (SELECT 1 FROM outputs o WHERE o.item_id = si.id) THEN 1 ELSE 0 END AS has_output
         FROM space_items si
        WHERE si.space_id = ?
        ORDER BY si.sort_order, si.id
        LIMIT ${MAX_SCAN}`,
    )
    .all(spaceId) as Array<{
    id: number;
    sort_order: number;
    pins_count: number;
    pins_with_text: number;
    has_output: 0 | 1;
  }>;

  const afterRow = after ? rows.find((row) => row.id === after) : undefined;
  // after 之后的第一页在列表中的下标；after 无效（不在本空间）时从头开始
  const startIndex = afterRow ? rows.indexOf(afterRow) + 1 : 0;

  const matches = (row: (typeof rows)[number]) =>
    type === 'untranslated'
      ? row.pins_count > 0 && row.pins_with_text < row.pins_count
      : row.has_output === 0;

  // 先向后找，再绕回头部补扫一遍（wrap），保证任何起点都能找到「下一个」
  for (let i = startIndex; i < rows.length; i++) {
    if (matches(rows[i])) return NextResponse.json({ itemId: rows[i].id });
  }
  for (let i = 0; i < startIndex; i++) {
    if (matches(rows[i])) return NextResponse.json({ itemId: rows[i].id });
  }

  return NextResponse.json({ itemId: null });
}
