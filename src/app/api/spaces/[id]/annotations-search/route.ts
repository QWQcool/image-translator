import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type SearchRow = {
  annotation_id: number;
  kind: string;
  text: string;
  source_text: string;
  item_id: number;
  item_title: string | null;
};

/** 取命中位置附近的片段预览（带省略号） */
function snippetOf(text: string, keyword: string): string {
  const index = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return text.slice(0, 30);
  const start = Math.max(0, index - 12);
  const end = Math.min(text.length, index + keyword.length + 12);
  const body = text.slice(start, end).replace(/\n/g, '⏎');
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * 空间内标注全文搜索：LIKE 匹配 annotations 的 text / source_text，
 * 返回命中标注的所在条目、片段预览（上限 200 条）。
 * 点击结果由前端跳转 /annotate/[itemId]?focus=<annotationId> 定位。
 */
export async function GET(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const denied = accessError(getSpaceAccess(id, user.id), 'view');
  if (denied) return denied;

  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ error: '搜索词不能为空' }, { status: 400 });

  const rows = db
    .prepare(
      `SELECT an.id       AS annotation_id,
              an.kind     AS kind,
              an.text     AS text,
              an.source_text AS source_text,
              si.id       AS item_id,
              si.title    AS item_title
         FROM annotations an
         JOIN space_items si ON si.id = an.item_id
        WHERE si.space_id = ? AND (an.text LIKE ? OR an.source_text LIKE ?)
        ORDER BY si.sort_order, an.order_index, an.id
        LIMIT 200`,
    )
    .all(id, `%${q}%`, `%${q}%`) as SearchRow[];

  const results = rows.map((row) => {
    // 优先在译文中给片段，译文没命中再给原文片段
    const snippet = row.text.toLowerCase().includes(q.toLowerCase())
      ? snippetOf(row.text, q)
      : snippetOf(row.source_text, q);
    return {
      itemId: row.item_id,
      itemTitle: row.item_title,
      annotationId: row.annotation_id,
      kind: row.kind,
      snippet,
    };
  });

  return NextResponse.json({ results, total: results.length });
}
