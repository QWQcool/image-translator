import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { IMAGE_DIRS } from '@/lib/storage';
import { sidecarHealth, sidecarOcr, type OcrBlock } from '@/lib/sidecar';
import type { Annotation } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

function nearExisting(cx: number, cy: number, pins: Annotation[]): boolean {
  return pins.some((pin) => Math.hypot(pin.x - cx, pin.y - cy) < 0.04);
}

export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db
    .prepare(
      `SELECT si.space_id, a.filename, a.mime_type
         FROM space_items si JOIN assets a ON a.id = si.asset_id
        WHERE si.id = ?`,
    )
    .get(itemId) as { space_id: number; filename: string; mime_type: string } | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  const healthy = await sidecarHealth();
  if (!healthy) {
    return NextResponse.json(
      {
        error: '本机识别进程未启动。OCR 走 sidecar，不把大模型塞进浏览器。',
        sidecar: sidecarUrlHint(),
      },
      { status: 503 },
    );
  }

  const filePath = path.join(IMAGE_DIRS.IMAGES_DIR, item.filename);
  const image = await fs.readFile(filePath);
  const result = await sidecarOcr(image, item.mime_type);
  if (!result) {
    return NextResponse.json({ error: '识别进程没有返回结果' }, { status: 502 });
  }

  const pins = db
    .prepare(`SELECT * FROM annotations WHERE item_id = ? AND kind = 'pin'`)
    .all(itemId) as Annotation[];

  const proposals = result.blocks
    .map((block: OcrBlock) => {
      const w = Math.min(1, Math.max(0.01, block.w || 0.08));
      const h = Math.min(1, Math.max(0.01, block.h || 0.04));
      const x = Math.min(1, Math.max(0, block.x));
      const y = Math.min(1, Math.max(0, block.y));
      const cx = x + w / 2;
      const cy = y + h / 2;
      return {
        x: cx,
        y: cy,
        box: { x, y, w, h },
        source_text: String(block.text ?? '').trim(),
        confidence: block.confidence ?? null,
        skipped: nearExisting(cx, cy, pins),
      };
    })
    .filter((row) => !row.skipped);

  return NextResponse.json({ proposals, sidecar: true });
}

function sidecarUrlHint(): string {
  return process.env.SIDECAR_URL ?? 'http://127.0.0.1:8765';
}
