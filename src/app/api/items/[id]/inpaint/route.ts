import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { IMAGE_DIRS } from '@/lib/storage';
import { aiConfigured, imageEditWithMask, resolveAiConfig } from '@/lib/ai';
import { maskPng, teleaFallback, type NormBox } from '@/lib/inpaint';
import { sidecarHealth, sidecarInpaint } from '@/lib/sidecar';

type Params = { params: Promise<{ id: string }> };

/**
 * 漂移校验：AI 生成式编辑可能把 mask 外的像素也改了。
 * 把 AI 结果缩放回原尺寸后，逐点采样 mask 外区域的 RGB 差值，
 * 平均差超过阈值就判定"画歪了"，调用方回退到确定性引擎。
 */
async function outsideMaskDrift(
  original: Buffer,
  result: Buffer,
  mask: Buffer,
  width: number,
  height: number,
  threshold = 14,
): Promise<boolean> {
  try {
    const W = Math.max(1, Math.min(512, width));
    const H = Math.max(1, Math.min(512, height));
    const scale = { width: W, height: H, fit: 'fill' as const };
    const a = await sharp(original).rotate().resize(scale).raw().toBuffer();
    const b = await sharp(result).resize(scale).raw().toBuffer();
    const m = await sharp(mask).resize(scale).raw().toBuffer();
    const channels = 3;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < W * H; i += 1) {
      // mask 是黑色（透明）= 不去字区域；白色 = 去字区域。非白才算 mask 外
      const mg = m[i * channels] ?? 0;
      if (mg > 128) continue;
      const dr = Math.abs(a[i * channels] - b[i * channels]);
      const dg = Math.abs(a[i * channels + 1] - b[i * channels + 1]);
      const db = Math.abs(a[i * channels + 2] - b[i * channels + 2]);
      sum += (dr + dg + db) / 3;
      count += 1;
    }
    if (count === 0) return false;
    return sum / count > threshold;
  } catch {
    return true; // 校验本身失败就宁可保守，回退确定性引擎
  }
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
  let engine: 'lama' | 'telea' | 'ai' = 'telea';
  const mask = await maskPng(width, height, boxes);

  // 引擎优先级：sidecar LaMa（本地、确定性最好）> AI 生成式（当前用户自己的 token）> telea（零依赖兜底）
  let aiPaint: Buffer | null = null;
  if (!(await sidecarHealth())) {
    const aiConfig = resolveAiConfig(user.id, 'inpaint');
    if (aiConfigured(aiConfig, 'inpaint')) {
      const size = width >= height ? '1536x1024' : '1024x1536';
      const padded = await sharp(original).rotate().png().toBuffer();
      aiPaint = await imageEditWithMask(
        aiConfig,
        padded,
        mask,
        'Remove the text inside the masked area and fill it with the surrounding background (screentone/lineart). Keep everything outside the mask exactly unchanged.',
        size,
      );
    }
  }

  if (await sidecarHealth()) {
    const lama = await sidecarInpaint(original, mask);
    if (lama) {
      paint = lama;
      engine = 'lama';
    } else {
      paint = await teleaFallback(original, boxes);
    }
  } else if (aiPaint) {
    // 漂移校验：生成式编辑可能把 mask 外的线稿也改了。
    // 只比较 mask 外区域，平均差异超过阈值就拒收，回退到 telea。
    const drifted = await outsideMaskDrift(original, aiPaint, mask, width, height);
    if (drifted) {
      paint = await teleaFallback(original, boxes);
    } else {
      // AI 返回的尺寸可能和原图不一致，缩放回原尺寸
      paint = await sharp(aiPaint)
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer();
      engine = 'ai';
    }
  } else {
    paint = await teleaFallback(original, boxes);
  }

  // AI 调用埋点：只有 AI 生成式引擎真正生效才记（漂移拒收/本地引擎不刷日志）
  if (engine === 'ai') {
    logOp(user.id, 'ai_inpaint', 'ai', itemId, itemDisplayName(itemId), `AI 去字（${boxes.length} 个区域）`);
  }

  return new NextResponse(new Uint8Array(paint), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-store',
      'X-Inpaint-Engine': engine,
    },
  });
}
