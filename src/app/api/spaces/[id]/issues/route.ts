import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type IssueRow = {
  annotation_id: number;
  order_index: number;
  source_text: string;
  text: string;
  item_id: number;
  item_title: string | null;
};

/** 清单上限：超过说明空间大到清单本身失去处理意义，截断并提示 */
const MAX_ISSUES = 500;

/**
 * 存疑跨页汇总：该空间全部存疑标号（kind='pin' 且 doubtful=1），
 * 按页序（sort_order）+ 标号序（order_index）排序，供详情页「存疑清单」弹窗展示。
 * 点击行由前端跳转 /annotate/[itemId]?focus=<annotationId> 定位。
 */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(id, user.id), 'view');
  if (denied) return denied;

  const rows = db
    .prepare(
      `SELECT an.id       AS annotation_id,
              an.order_index,
              an.source_text,
              an.text,
              si.id        AS item_id,
              si.title     AS item_title
         FROM annotations an
         JOIN space_items si ON si.id = an.item_id
        WHERE si.space_id = ? AND an.kind = 'pin' AND an.doubtful = 1
        ORDER BY si.sort_order, an.order_index, an.id
        LIMIT ${MAX_ISSUES}`,
    )
    .all(id) as IssueRow[];

  return NextResponse.json({
    issues: rows.map((row) => ({
      itemId: row.item_id,
      itemTitle: row.item_title,
      annotationId: row.annotation_id,
      orderIndex: row.order_index,
      sourceText: row.source_text,
      text: row.text,
    })),
    // 恰好等于上限时无法区分「正好 500 条」与「还有更多」，保守提示可能被截断
    truncated: rows.length >= MAX_ISSUES,
  });
}
