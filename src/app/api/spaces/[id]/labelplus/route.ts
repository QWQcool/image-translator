import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { parseGroups, parsePhrases } from '@/lib/labelplus';
import type { LabelPlusGroup, Space } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const denied = accessError(getSpaceAccess(id, user.id), 'view');
  if (denied) return denied;

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined;
  if (!space) return NextResponse.json({ error: '空间不存在' }, { status: 404 });

  return NextResponse.json({
    groups: parseGroups(space.lp_groups),
    phrases: parsePhrases(space.lp_phrases),
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const denied = accessError(getSpaceAccess(id, user.id), 'edit');
  if (denied) return denied;

  let body: { groups?: LabelPlusGroup[]; phrases?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space | undefined;
  if (!space) return NextResponse.json({ error: '空间不存在' }, { status: 404 });

  let groupsJson: string | null = null;
  let phrasesJson: string | null = null;

  if (body.groups) {
    const groups = body.groups
      .filter((g) => Number.isInteger(g.id) && g.id >= 1 && g.id <= 9)
      .slice(0, 9)
      .map((g) => ({ id: g.id, name: String(g.name || `分组${g.id}`).slice(0, 20) }));
    if (groups.length === 0) {
      return NextResponse.json({ error: '至少保留一个分组' }, { status: 400 });
    }
    groupsJson = JSON.stringify(groups);
  }
  if (body.phrases) {
    phrasesJson = JSON.stringify(
      body.phrases.map((p) => String(p).slice(0, 80)).filter(Boolean).slice(0, 40),
    );
  }

  if (groupsJson === null && phrasesJson === null) {
    return NextResponse.json({ error: '没有需要更新的字段' }, { status: 400 });
  }

  db.prepare(
    `UPDATE spaces
        SET lp_groups = COALESCE(?, lp_groups),
            lp_phrases = COALESCE(?, lp_phrases),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(groupsJson, phrasesJson, id);

  const next = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Space;
  return NextResponse.json({
    groups: parseGroups(next.lp_groups),
    phrases: parsePhrases(next.lp_phrases),
  });
}
