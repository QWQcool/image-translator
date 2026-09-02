import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NextResponse } from 'next/server';
import { aiConfigured, readAiConfig, toDataUrl } from '@/lib/ai';
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

type VisionBlock = { x: number; y: number; w: number; h: number; text: string };

/**
 * 用 OpenAI 兼容的视觉对话模型做 OCR：
 * 图片缩到 1600px 转 base64，要求模型输出归一化坐标的 JSON 数组。
 * 视觉模型数格子不如专用 OCR 准，但零部署、跨语言，创作者用自己的 token。
 */
async function visionOcr(
  image: Buffer,
  mime: string,
  config: { baseUrl: string; apiKey: string; ocrModel: string },
): Promise<VisionBlock[] | null> {
  try {
    // 视觉模型对超大图不友好，统一压到长边 1600
    const resized = await sharp(image).rotate().resize({ width: 1600, height: 1600, fit: 'inside' }).png().toBuffer();
    const meta = await sharp(resized).metadata();
    const dataUrl = toDataUrl(resized, 'image/png');

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ocrModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `这是漫画/图片，尺寸 ${meta.width}x${meta.height}。找出图中所有对话气泡和独立文字块。` +
                  '只输出 JSON 数组，不要任何其它文字：' +
                  '[{"x":0.12,"y":0.34,"w":0.2,"h":0.08,"text":"原文"}]，' +
                  '其中 x/y/w/h 是相对图片宽高的 0~1 归一化值（x/y 为块左上角），text 是块内原文。没有文字时输出 []。',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Array<{
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      text?: string;
    }>;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && typeof b.text === 'string')
      .map((b) => ({
        x: Math.min(1, Math.max(0, Number(b.x))),
        y: Math.min(1, Math.max(0, Number(b.y))),
        w: Math.min(1, Math.max(0.01, Number(b.w ?? 0.1))),
        h: Math.min(1, Math.max(0.01, Number(b.h ?? 0.04))),
        text: String(b.text ?? ''),
      }));
  } catch {
    return null;
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
      `SELECT si.space_id, a.filename, a.mime_type
         FROM space_items si JOIN assets a ON a.id = si.asset_id
        WHERE si.id = ?`,
    )
    .get(itemId) as { space_id: number; filename: string; mime_type: string } | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  const filePath = path.join(IMAGE_DIRS.IMAGES_DIR, item.filename);
  const image = await fs.readFile(filePath);

  // 优先走"我自己"配置的 AI 视觉模型；没配置或失败再退回本机 sidecar
  const aiConfig = readAiConfig(user.id);
  let blocks: OcrBlock[] | null = null;
  let engine: 'ai' | 'sidecar' = 'sidecar';

  if (aiConfigured(aiConfig, 'ocr')) {
    const visionBlocks = await visionOcr(image, 'image/png', {
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      ocrModel: aiConfig.ocrModel,
    });
    if (visionBlocks && visionBlocks.length > 0) {
      blocks = visionBlocks;
      engine = 'ai';
    }
  }

  if (!blocks) {
    const healthy = await sidecarHealth();
    if (!healthy) {
      return NextResponse.json(
        {
          error: aiConfigured(aiConfig, 'ocr')
            ? 'AI 识别调用失败（检查 AI 设置里的 Base URL / Key / 模型名），本机识别进程也未启动。'
            : '没有可用的识别引擎：去「AI 设置」填入你自己的 OpenAI 兼容视觉模型 token，或启动本机 sidecar。',
          sidecar: sidecarUrlHint(),
        },
        { status: 503 },
      );
    }
    const result = await sidecarOcr(image, item.mime_type);
    if (!result) {
      return NextResponse.json({ error: '识别进程没有返回结果' }, { status: 502 });
    }
    blocks = result.blocks;
  }

  const pins = db
    .prepare(`SELECT * FROM annotations WHERE item_id = ? AND kind = 'pin'`)
    .all(itemId) as Annotation[];

  const proposals = blocks
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

  return NextResponse.json({ proposals, sidecar: engine === 'sidecar', engine });
}

function sidecarUrlHint(): string {
  return process.env.SIDECAR_URL ?? 'http://127.0.0.1:8765';
}
