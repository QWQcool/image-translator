import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { checkText } from '@/lib/text-check';

type Params = { params: Promise<{ id: string }> };

type PinRow = {
  annotation_id: number;
  order_index: number;
  text: string;
  source_text: string;
  doubtful: number;
  item_id: number;
  item_title: string | null;
};

/** 页数上限防御：超大空间只检查前 500 页（按页序），结果里带提示 */
const MAX_PAGES = 500;
/** 标号行数兜底上限（500 页 × 均匀几十个标号绰绰有余） */
const MAX_PINS = 30000;

/**
 * 终检只报「可自动修的硬伤类」标点规则（省略号 / 多余空行 / 首尾空白），
 * 与单页检查共用 text-check.ts 的一套规则，口径一致；
 * 仅提示类（标点混用/引号/重复标点等）留给编辑器内的单页「检查」按钮，终检不刷屏。
 */
const FINAL_CHECK_RULES = new Set(['省略号', '多余空行', '首尾空白']);

/**
 * 全空间终检：把空译文 / 存疑未清 / 标点硬伤三类问题分组汇总。
 * GET（幂等只读检查，不落库不写日志），登录即可用。
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

  // 页数截断判定 + 参与检查的页集合（子查询先按页序取前 500 页）
  const pagesRow = db
    .prepare('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?')
    .get(id) as { n: number };
  const pagesTruncated = pagesRow.n > MAX_PAGES;

  const rows = db
    .prepare(
      `SELECT an.id       AS annotation_id,
              an.order_index,
              an.text,
              an.source_text,
              an.doubtful,
              si.id        AS item_id,
              si.title     AS item_title
         FROM annotations an
         JOIN space_items si ON si.id = an.item_id
        WHERE si.space_id = ?
          AND an.kind = 'pin'
          AND si.id IN (
            SELECT id FROM space_items WHERE space_id = ? ORDER BY sort_order, id LIMIT ${MAX_PAGES}
          )
        ORDER BY si.sort_order, an.order_index, an.id
        LIMIT ${MAX_PINS}`,
    )
    .all(id, id) as PinRow[];

  const emptyText: Array<{
    itemId: number;
    itemTitle: string | null;
    annotationId: number;
    orderIndex: number;
    sourceText: string;
  }> = [];
  const doubtful: Array<{
    itemId: number;
    itemTitle: string | null;
    annotationId: number;
    orderIndex: number;
    text: string;
    sourceText: string;
  }> = [];
  const punctuation: Array<{
    itemId: number;
    itemTitle: string | null;
    annotationId: number;
    orderIndex: number;
    text: string;
    issues: Array<{ rule: string; message: string; snippet: string }>;
  }> = [];

  for (const row of rows) {
    const base = {
      itemId: row.item_id,
      itemTitle: row.item_title,
      annotationId: row.annotation_id,
      orderIndex: row.order_index,
    };
    const textEmpty = row.text.trim() === '';
    // 空译文与存疑可同时命中（一个标号出现在两个分组是预期行为，都该被看到）
    if (textEmpty) emptyText.push({ ...base, sourceText: row.source_text });
    if (row.doubtful === 1) {
      doubtful.push({ ...base, text: row.text, sourceText: row.source_text });
      // 存疑标号的标点检查没有意义（译文大概率还要大改），跳过降噪
      continue;
    }
    if (textEmpty) continue;
    const issues = checkText(row.text)
      .filter((issue) => FINAL_CHECK_RULES.has(issue.rule))
      .map(({ rule, message, snippet }) => ({ rule, message, snippet }));
    if (issues.length > 0) punctuation.push({ ...base, text: row.text, issues });
  }

  return NextResponse.json({
    groups: { emptyText, doubtful, punctuation },
    pagesTruncated,
    checkedPages: Math.min(pagesRow.n, MAX_PAGES),
  });
}
