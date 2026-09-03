import { NextResponse } from 'next/server';
import { parseRuns, replaceInAnnotation, type TextRun } from '@/lib/annotation';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type ReplaceRow = {
  id: number;
  text: string;
  source_text: string;
  /** runs 列是 JSON 字符串（富文本分段） */
  runs: string | null;
  item_title: string | null;
};

/**
 * 空间内标注批量替换：字面量精确匹配（不做正则），空 find 直接 400。
 * 事务内批量改写 text / source_text / runs（富文本逐段同步替换），
 * 整行无变化跳过，返回改动条目标题列表。
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  // 批量改写属于「改」，viewer 不允许
  const denied = accessError(getSpaceAccess(id, user.id), 'edit');
  if (denied) return denied;

  let body: { find?: string; replace?: string; includeSource?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const find = String(body.find ?? '');
  const replace = String(body.replace ?? '');
  if (!find) return NextResponse.json({ error: '查找词不能为空' }, { status: 400 });

  // 空间内所有可能命中的行（LIKE 先粗筛，精确替换在 JS 里做字面量匹配）
  const rows = db
    .prepare(
      `SELECT an.id, an.text, an.source_text, an.runs, si.title AS item_title
         FROM annotations an
         JOIN space_items si ON si.id = an.item_id
        WHERE si.space_id = ? AND (an.text LIKE ? OR an.source_text LIKE ?)`,
    )
    .all(id, `%${find}%`, `%${find}%`) as ReplaceRow[];

  const update = db.prepare(
    'UPDATE annotations SET text = ?, source_text = ?, runs = ? WHERE id = ?',
  );

  let changed = 0;
  const titleSet = new Set<string>();

  db.transaction(() => {
    for (const row of rows) {
      // runs JSON 字符串 → 结构化数组，替换后与 PUT 保存路径同语义规范化
      const parsedRuns = parseRuns(row.runs);
      const result = replaceInAnnotation(
        { text: row.text, source_text: row.source_text, runs: parsedRuns },
        find,
        replace,
        Boolean(body.includeSource),
      );
      // runs 无实际变化时保留原 JSON 串（不 reformat 未涉及字段）
      const runsChanged =
        JSON.stringify(result.runs) !== JSON.stringify(parsedRuns);
      const nextRuns = runsChanged
        ? result.runs
          ? JSON.stringify(result.runs as TextRun[])
          : null
        : row.runs;
      if (result.text === row.text && result.source_text === row.source_text && !runsChanged) {
        continue;
      }
      update.run(result.text, result.source_text, nextRuns, row.id);
      changed += 1;
      titleSet.add(row.item_title ?? '未命名');
    }
    if (changed > 0) {
      db.prepare(`UPDATE spaces SET updated_at = datetime('now') WHERE id = ?`).run(id);
    }
  })();

  const space = db.prepare('SELECT name FROM spaces WHERE id = ?').get(id) as
    | { name: string }
    | undefined;
  if (changed > 0) {
    logOp(
      user.id,
      'update',
      'space',
      id,
      space?.name ?? `空间 ${id}`,
      `空间内替换「${find}」→「${replace}」，改动 ${changed} 条标注`,
    );
  }

  return NextResponse.json({ changed, titles: Array.from(titleSet) });
}
