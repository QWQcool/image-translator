import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NextResponse } from 'next/server';
import {
  aiConfigured,
  detectTextBlocks,
  detectionConfigured,
  extractTextInBox,
  resolveAiConfig,
  resolveDetectionConfig,
  toDataUrl,
} from '@/lib/ai';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';
import { IMAGE_DIRS } from '@/lib/storage';
import { sidecarHealth, sidecarOcr, type OcrBlock } from '@/lib/sidecar';
import type { Annotation } from '@/lib/types';

type Params = { params: Promise<{ id: string }> };

function nearExisting(cx: number, cy: number, pins: Annotation[]): boolean {
  return pins.some((pin) => Math.hypot(pin.x - cx, pin.y - cy) < 0.04);
}

type VisionBlock = { x: number; y: number; w: number; h: number; text: string };

type VisionResult = { blocks: VisionBlock[]; description: string | null };

/**
 * 用 OpenAI 兼容的视觉对话模型做 OCR，顺带输出一段图片内容描述（6c 图像解析）：
 * 图片缩到 1600px 转 base64，要求模型输出 {"blocks":[...],"description":"…"}。
 * 兼容旧格式（裸数组）——只有 blocks，没有 description。
 * 视觉模型数格子不如专用 OCR 准，但零部署、跨语言，创作者用自己的 token。
 */
async function visionOcr(
  image: Buffer,
  mime: string,
  config: { baseUrl: string; apiKey: string; ocrModel: string },
): Promise<VisionResult | null> {
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
                  `这是漫画/图片，尺寸 ${meta.width}x${meta.height}。找出图中所有对话气泡和独立文字块，` +
                  '并用一句话输出图片内容描述（对话人物/场景/剧情提示，中文）。\n' +
                  '只输出 JSON 对象，不要任何其它文字：' +
                  '{"blocks":[{"x":0.12,"y":0.34,"w":0.2,"h":0.08,"text":"原文"}],"description":"图片内容描述"}，' +
                  '其中 x/y/w/h 是相对图片宽高的 0~1 归一化值（x/y 为块左上角），text 是块内原文；没有文字时 blocks 输出 []。',
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
    // 新格式：{"blocks":[...],"description":"…"}；兼容旧格式：裸 [...]
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]) as {
          blocks?: Array<{ x?: number; y?: number; w?: number; h?: number; text?: string }>;
          description?: string;
        };
        if (Array.isArray(parsed.blocks)) {
          return {
            blocks: parsed.blocks
              .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && typeof b.text === 'string')
              .map((b) => ({
                x: Math.min(1, Math.max(0, Number(b.x))),
                y: Math.min(1, Math.max(0, Number(b.y))),
                w: Math.min(1, Math.max(0.01, Number(b.w ?? 0.1))),
                h: Math.min(1, Math.max(0.01, Number(b.h ?? 0.04))),
                text: String(b.text ?? ''),
              })),
            description: typeof parsed.description === 'string' && parsed.description.trim()
              ? parsed.description.trim().slice(0, 500)
              : null,
          };
        }
      } catch {
        // 对象解析失败时继续尝试旧格式
      }
    }
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return null;
    const parsed = JSON.parse(arrayMatch[0]) as Array<{
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      text?: string;
    }>;
    if (!Array.isArray(parsed)) return null;
    return {
      blocks: parsed
        .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && typeof b.text === 'string')
        .map((b) => ({
          x: Math.min(1, Math.max(0, Number(b.x))),
          y: Math.min(1, Math.max(0, Number(b.y))),
          w: Math.min(1, Math.max(0.01, Number(b.w ?? 0.1))),
          h: Math.min(1, Math.max(0.01, Number(b.h ?? 0.04))),
          text: String(b.text ?? ''),
        })),
      description: null,
    };
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
  const aiConfig = resolveAiConfig(user.id, 'ocr');
  const detConfig = resolveDetectionConfig(user.id);
  let blocks: OcrBlock[] | null = null;
  let engine: 'ai' | 'sidecar' = 'sidecar';
  let description: string | null = null;
  let twoStep = false;

  // Stage 6：配置了文本块检测服务 → 两步链路（检测出框 → 空框裁剪补提取）；
  // 检测失败（服务异常/解析失败）时回退到下面的单步视觉链路，保证可用性。
  if (detectionConfigured(detConfig)) {
    const resizedForDetect = await sharp(image)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside' })
      .png()
      .toBuffer();
    const detMeta = await sharp(resizedForDetect).metadata();
    const detected = await detectTextBlocks(detConfig, toDataUrl(resizedForDetect, 'image/png'), {
      width: detMeta.width ?? 1,
      height: detMeta.height ?? 1,
    });
    if (detected) {
      twoStep = true;
      engine = 'ai';
      // 空框用视觉对话模型对裁剪区域补提取（并发 2，避免一页几十框把 token 打爆）
      const emptyIndexes = detected
        .map((b, i) => (b.text.trim() ? -1 : i))
        .filter((i) => i >= 0);
      const fillLimit = 2;
      let cursor = 0;
      const filled = new Map<number, string>();
      await Promise.all(
        Array.from({ length: Math.min(fillLimit, emptyIndexes.length) }, async () => {
          while (cursor < emptyIndexes.length) {
            const pos = cursor;
            cursor += 1;
            const text = await extractTextInBox(
              { baseUrl: aiConfig.baseUrl, apiKey: aiConfig.apiKey, ocrModel: aiConfig.ocrModel },
              image,
              item.mime_type,
              detected[emptyIndexes[pos]],
            );
            if (text) filled.set(pos, text);
          }
        }),
      );
      blocks = detected.map((b, i) => {
        const emptyPos = emptyIndexes.indexOf(i);
        if (emptyPos < 0) return b;
        return { ...b, text: filled.get(emptyPos) ?? '' };
      });
    }
  }

  if (!blocks && aiConfigured(aiConfig, 'ocr')) {
    const vision = await visionOcr(image, 'image/png', {
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      ocrModel: aiConfig.ocrModel,
    });
    if (vision && vision.blocks.length > 0) {
      blocks = vision.blocks;
      description = vision.description;
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

  // AI 调用埋点：只有真正用了用户自己的视觉模型才记（sidecar 是本机确定性引擎）
  if (engine === 'ai') {
    logOp(
      user.id,
      'ai_ocr',
      'ai',
      itemId,
      itemDisplayName(itemId),
      twoStep
        ? `两步 OCR（检测服务出框 + 视觉补提取），识别出 ${proposals.length} 个文字块`
        : `AI 视觉识别，识别出 ${proposals.length} 个文字块`,
    );
    // 6c 图像解析：把内容描述存到条目上，AI 翻译时作为上下文
    if (description) {
      db.prepare('UPDATE space_items SET ai_context = ? WHERE id = ?').run(description, itemId);
    }
  }

  const aiContext = engine === 'ai' ? description : null;
  return NextResponse.json({ proposals, sidecar: engine === 'sidecar', engine, twoStep, aiContext });
}

function sidecarUrlHint(): string {
  return process.env.SIDECAR_URL ?? 'http://127.0.0.1:8765';
}
