import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { IMAGE_DIRS } from '@/lib/storage';
import { maskPng, teleaFallback, type NormBox } from '@/lib/inpaint';
import { sidecarHealth, sidecarInpaint } from '@/lib/sidecar';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db
    .prepare(
      `SELECT si.space_id, a.filename, a.width, a.height
         FROM space_items si JOIN assets a ON a.id = si.asset_id
        WHERE si.id = ?`,
    )
    .get(itemId) as
    | { space_id: number; filename: string; width: number | null; height: number | null }
    | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  let body: { boxes?: NormBox[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  let boxes = (body.boxes ?? []).filter(
    (b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h),
  );
  if (boxes.length === 0) {
    const pins = db
      .prepare(`SELECT x, y FROM annotations WHERE item_id = ? AND kind = 'pin'`)
      .all(itemId) as Array<{ x: number; y: number }>;
    boxes = pins.map((pin) => ({ x: pin.x - 0.06, y: pin.y - 0.03, w: 0.12, h: 0.06 }));
  }
  if (boxes.length === 0) {
    return NextResponse.json({ error: '没有可去字的区域' }, { status: 400 });
  }

  const filePath = path.join(IMAGE_DIRS.IMAGES_DIR, item.filename);
  const original = await fs.readFile(filePath);
  const meta = await sharp(original).rotate().metadata();
  const width = meta.width ?? item.width ?? 0;
  const height = meta.height ?? item.height ?? 0;

  let paint: Buffer;
  let engine: 'lama' | 'telea' = 'telea';
  if (await sidecarHealth()) {
    const mask = await maskPng(width, height, boxes);
    const lama = await sidecarInpaint(original, mask);
    if (lama) {
      paint = lama;
      engine = 'lama';
    } else {
      paint = await teleaFallback(original, boxes);
    }
  } else {
    paint = await teleaFallback(original, boxes);
  }

  return new NextResponse(new Uint8Array(paint), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Inpaint-Engine': engine,
    },
  });
}
