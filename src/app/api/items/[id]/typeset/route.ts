import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { saveGuard } from '@/lib/room';
import { readTypesetMeta, readTypesetPaint, writeTypeset, type TypesetTextLayer } from '@/lib/typeset';

type Params = { params: Promise<{ id: string }> };

function loadItem(itemId: number, userId: number) {
  const item = db.prepare('SELECT id, space_id FROM space_items WHERE id = ?').get(itemId) as
    | { id: number; space_id: number }
    | undefined;
  if (!item) return { item: null, access: null };
  return { item, access: getSpaceAccess(item.space_id, userId) };
}

export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const { item, access } = loadItem(itemId, user.id);
  const denied = accessError(access, 'view');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  const meta = await readTypesetMeta(itemId);
  const paint = await readTypesetPaint(itemId);
  return NextResponse.json({
    meta,
    hasPaint: Boolean(paint),
    canEdit: access?.canEdit ?? false,
  });
}

export async function PUT(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const { item, access } = loadItem(itemId, user.id);
  const denied = accessError(access, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  // 协作锁：别人持锁且未共享时不允许覆盖嵌字草稿
  const guard = saveGuard(itemId, user.id);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: 423 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const rawMeta = String(form.get('meta') ?? '');
  let textLayers: TypesetTextLayer[] = [];
  let width = 0;
  let height = 0;
  try {
    const parsed = JSON.parse(rawMeta) as { textLayers?: TypesetTextLayer[]; width?: number; height?: number };
    textLayers = Array.isArray(parsed.textLayers) ? parsed.textLayers.slice(0, 200) : [];
    width = Number(parsed.width) || 0;
    height = Number(parsed.height) || 0;
  } catch {
    return NextResponse.json({ error: 'meta 格式错误' }, { status: 400 });
  }

  const paintFile = form.get('paint');
  let paint: Buffer | null = null;
  if (paintFile instanceof File && paintFile.size > 0) {
    if (paintFile.size > 40 * 1024 * 1024) {
      return NextResponse.json({ error: '涂改层过大' }, { status: 400 });
    }
    paint = Buffer.from(await paintFile.arrayBuffer());
  }

  await writeTypeset(
    itemId,
    { version: 1, width, height, textLayers, updatedAt: new Date().toISOString() },
    paint,
  );
  return NextResponse.json({ ok: true });
}
