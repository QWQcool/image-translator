import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type TmRow = { source_text: string; text: string };

/** 扫描上限：防止超大空间的查询一次拉爆（按 updated_at 新→旧截断） */
const MAX_SCAN = 8000;
/** 返回条目上限 */
const MAX_ENTRIES = 2000;

/**
 * 空间翻译记忆（TM）：source_text 与 text 都非空的 pin，按原文去重（保留 updated_at 最新）。
 * 编辑器加载时一次性拉取静态使用（不实时），用于「记忆命中：一键采用」。
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

  // ORDER BY updated_at DESC：JS 侧「首次遇到的 key 保留」即最新版本
  const rows = db
    .prepare(
      `SELECT an.source_text, an.text
         FROM annotations an
         JOIN space_items si ON si.id = an.item_id
        WHERE si.space_id = ?
          AND an.kind = 'pin'
          AND TRIM(an.source_text) <> '' AND TRIM(an.text) <> ''
        ORDER BY an.updated_at DESC, an.id DESC
        LIMIT ${MAX_SCAN}`,
    )
    .all(id) as TmRow[];

  const memory: Record<string, string> = {};
  for (const row of rows) {
    const key = row.source_text.trim();
    if (!key || key in memory) continue;
    memory[key] = row.text;
    if (Object.keys(memory).length >= MAX_ENTRIES) break;
  }

  return NextResponse.json({ memory, truncated: rows.length >= MAX_SCAN });
}
