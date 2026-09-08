import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type StatsRow = {
  item_id: number;
  pin_count: number;
  pins_with_text: number | null;
  pins_doubtful: number | null;
};

/** 参与聚合的页数上限：超过的空间截断聚合（返回 truncated=true），防止一次性聚出几十万行 */
const MAX_AGG_PAGES = 2000;

/**
 * 空间进度统计：页数 / 标号数 / 已填译文 / 存疑，外加两个页级分布指标。
 * 口径（与 issues / final-check 一致，仅统计 kind='pin' 的标号）：
 * - pinsWithText：pin 且 text 非空（TRIM 后）
 * - pinsDoubtful：pin 且 doubtful=1
 * - pagesWithTranslation：至少有一个非空译文 pin 的页数
 * - pagesWithoutPins：一个 pin 都没有的页数
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

  // 一次 GROUP BY 扫描聚合出全部页级指标（LEFT JOIN 保证无标号的页也出现在结果里）
  const rows = db
    .prepare(
      `SELECT si.id AS item_id,
              COUNT(an.id) AS pin_count,
              SUM(CASE WHEN TRIM(an.text) <> '' THEN 1 ELSE 0 END) AS pins_with_text,
              SUM(CASE WHEN an.doubtful = 1 THEN 1 ELSE 0 END) AS pins_doubtful
         FROM space_items si
         LEFT JOIN annotations an ON an.item_id = si.id AND an.kind = 'pin'
        WHERE si.space_id = ?
        GROUP BY si.id
        ORDER BY si.sort_order, si.id
        LIMIT ${MAX_AGG_PAGES}`,
    )
    .all(id) as StatsRow[];

  // 页数单独 COUNT：聚合被截断时 GROUP BY 的行数会少算页数
  const pagesRow = db
    .prepare('SELECT COUNT(*) AS n FROM space_items WHERE space_id = ?')
    .get(id) as { n: number };

  let pins = 0;
  let pinsWithText = 0;
  let pinsDoubtful = 0;
  let pagesWithTranslation = 0;
  let pagesWithoutPins = 0;
  for (const row of rows) {
    const withText = row.pins_with_text ?? 0;
    pins += row.pin_count;
    pinsWithText += withText;
    pinsDoubtful += row.pins_doubtful ?? 0;
    if (withText > 0) pagesWithTranslation += 1;
    if (row.pin_count === 0) pagesWithoutPins += 1;
  }

  return NextResponse.json({
    pages: pagesRow.n,
    pins,
    pinsWithText,
    pinsDoubtful,
    pagesWithTranslation,
    pagesWithoutPins,
    truncated: rows.length >= MAX_AGG_PAGES,
  });
}
