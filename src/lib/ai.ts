import sharp from 'sharp';
import { db } from './db';

/**
 * AI 网关配置：每个用户填自己的 OpenAI 兼容服务（DeepSeek / GPT / GLM / Qwen…）。
 * 多 Provider 存 ai_providers 表（可配多条，OCR/翻译/去字可选用哪条）；
 * 旧的 ai_configs 单条配置保留作兼容回退。key 永不下发前端。
 * 日志与记录（created_by 之类）仍用注册用户名，与 AI 配置无关。
 */
export type AiConfig = {
  /** 例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 视觉对话模型（OCR 用），如 deepseek-v4-flash-vision-exp */
  ocrModel: string;
  /** 对话模型（AI 翻译用）；留空时回退用 ocrModel */
  chatModel: string;
  /** 图像编辑模型（AI 去字用），如 gpt-image-1；留空 = 不启用 AI 去字 */
  imageModel: string;
};

type AiConfigRow = {
  user_id: number;
  base_url: string;
  api_key: string;
  ocr_model: string;
  image_model: string;
};

export type AiProviderRow = {
  id: number;
  user_id: number | null;
  name: string;
  base_url: string;
  api_key: string;
  ocr_model: string;
  chat_model: string;
  image_model: string;
  is_default: number;
};

/** 列出某用户自己的全部 Provider（官方渠道 user_id IS NULL 的记录不在其中） */
export function listProviders(userId: number): AiProviderRow[] {
  return db
    .prepare(
      `SELECT id, user_id, name, base_url, api_key, ocr_model, chat_model, image_model, is_default
         FROM ai_providers
        WHERE user_id = ?
        ORDER BY is_default DESC, id`,
    )
    .all(userId) as AiProviderRow[];
}

/** 取单条 Provider（只能取自己的） */
export function getProvider(userId: number, providerId: number): AiProviderRow | null {
  const row = db
    .prepare(
      `SELECT id, user_id, name, base_url, api_key, ocr_model, chat_model, image_model, is_default
         FROM ai_providers WHERE id = ? AND user_id = ?`,
    )
    .get(providerId, userId) as AiProviderRow | undefined;
  return row ?? null;
}

/** 旧的单条配置（兼容回退用） */
function readLegacyConfig(userId: number): AiConfig {
  const row = db
    .prepare(
      'SELECT user_id, base_url, api_key, ocr_model, image_model FROM ai_configs WHERE user_id = ?',
    )
    .get(userId) as AiConfigRow | undefined;
  if (!row) return { baseUrl: '', apiKey: '', ocrModel: '', chatModel: '', imageModel: '' };
  return {
    baseUrl: row.base_url.replace(/\/+$/, ''),
    apiKey: row.api_key,
    ocrModel: row.ocr_model,
    chatModel: row.ocr_model,
    imageModel: row.image_model,
  };
}

function rowToConfig(row: AiProviderRow): AiConfig {
  return {
    baseUrl: row.base_url.replace(/\/+$/, ''),
    apiKey: row.api_key,
    ocrModel: row.ocr_model,
    chatModel: row.chat_model || row.ocr_model,
    imageModel: row.image_model,
  };
}

/**
 * 解析当前用户生效的 AI 配置。
 * 优先默认 Provider（is_default=1），否则第一条；一个 Provider 都没有时回退旧 ai_configs。
 * 可按用途指定某条 Provider（providerId 传 0/undefined = 用默认）。
 */
export function resolveAiConfig(userId: number, which: 'ocr' | 'chat' | 'inpaint', providerId?: number): AiConfig {
  const rows = listProviders(userId);
  let row: AiProviderRow | undefined;
  if (providerId && providerId > 0) {
    row = rows.find((r) => r.id === providerId);
  }
  if (!row) {
    row = rows.find((r) => r.is_default === 1) ?? rows[0];
  }
  if (!row) return readLegacyConfig(userId);
  return rowToConfig(row);
}

/** 兼容旧调用点：解析默认配置（OCR/去字路由用） */
export function readAiConfig(userId: number): AiConfig {
  return resolveAiConfig(userId, 'ocr');
}

export function writeAiConfig(userId: number, config: AiConfig): void {
  db.prepare(
    `INSERT INTO ai_configs (user_id, base_url, api_key, ocr_model, image_model, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
         base_url = excluded.base_url,
         api_key = excluded.api_key,
         ocr_model = excluded.ocr_model,
         image_model = excluded.image_model,
         updated_at = excluded.updated_at`,
  ).run(userId, config.baseUrl, config.apiKey, config.ocrModel, config.imageModel);
}

/** 对外只暴露尾 4 位，避免整段 key 泄露到前端 */
export function maskKey(key: string): string {
  if (!key) return '';
  return `****${key.slice(-4)}`;
}

export function aiConfigured(config: AiConfig, which: 'ocr' | 'inpaint' | 'chat'): boolean {
  if (!config.baseUrl || !config.apiKey) return false;
  if (which === 'ocr') return Boolean(config.ocrModel);
  if (which === 'chat') return Boolean(config.chatModel || config.ocrModel);
  return Boolean(config.imageModel);
}

/** 把 Buffer 包成 OpenAI 视觉接口要的 data URL */
export function toDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 文本块检测服务配置（每用户独立，可选）。
 * 配置后 OCR 走「检测→提取」两步链路：先由检测模型出文字框，
 * 框自带文字直接用，空框再用视觉模型对裁剪区域补提取。
 */
export type DetectionConfig = {
  /** 'ai' = OpenAI 兼容视觉端点；'sidecar' = 本机检测进程（sidecar/detector.mjs） */
  source: 'ai' | 'sidecar';
  baseUrl: string;
  apiKey: string;
  model: string;
};

type DetectionRow = {
  detection_source: string;
  detection_base_url: string;
  detection_api_key: string;
  detection_model: string;
};

export function resolveDetectionConfig(userId: number): DetectionConfig {
  const row = db
    .prepare(
      'SELECT detection_source, detection_base_url, detection_api_key, detection_model FROM ai_configs WHERE user_id = ?',
    )
    .get(userId) as DetectionRow | undefined;
  if (!row) return { source: 'ai', baseUrl: '', apiKey: '', model: '' };
  return {
    source: row.detection_source === 'sidecar' ? 'sidecar' : 'ai',
    baseUrl: row.detection_base_url.replace(/\/+$/, ''),
    apiKey: row.detection_api_key,
    model: row.detection_model,
  };
}

export function detectionConfigured(config: DetectionConfig): boolean {
  if (config.source === 'sidecar') return true; // 本机检测进程内置，无需配置
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

/**
 * 保存检测服务配置。apiKey undefined = 保持不变；'clear' = 清除。
 * 存在 ai_configs 行就 UPDATE，不存在且要写时 INSERT。
 */
export function writeDetectionConfig(
  userId: number,
  config: { source?: 'ai' | 'sidecar'; baseUrl: string; apiKey?: string; model: string },
): void {
  const apiKey =
    config.apiKey === 'clear'
      ? ''
      : config.apiKey !== undefined
        ? config.apiKey
        : resolveDetectionConfig(userId).apiKey;
  const source = config.source === 'sidecar' ? 'sidecar' : 'ai';
  db.prepare(
    `INSERT INTO ai_configs (user_id, detection_source, detection_base_url, detection_api_key, detection_model, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
         detection_source = excluded.detection_source,
         detection_base_url = excluded.detection_base_url,
         detection_api_key = excluded.detection_api_key,
         detection_model = excluded.detection_model,
         updated_at = excluded.updated_at`,
  ).run(userId, source, config.baseUrl, apiKey, config.model);
}

export type DetectBlock = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 检测模型自带的文字；可能为空（空框由视觉模型补提取） */
  text: string;
};

/**
 * 文本块检测：OpenAI 兼容视觉端点（飞桨星河 PaddleOCR VL / 自定义均可），
 * 传整图要求输出归一化框数组，框内文字可选。
 */
export async function detectTextBlocks(
  config: DetectionConfig,
  imageDataUrl: string,
  imageMeta: { width: number; height: number },
): Promise<DetectBlock[] | null> {
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `这是漫画/图片，尺寸 ${imageMeta.width}x${imageMeta.height}。检测图中所有对话气泡和独立文字块，` +
                  '只输出 JSON 对象，不要任何其它文字：' +
                  '{"blocks":[{"x":0.12,"y":0.34,"w":0.2,"h":0.08,"text":"原文"}]}，' +
                  '其中 x/y/w/h 是相对图片宽高的 0~1 归一化值（x/y 为块左上角）；' +
                  'text 是块内原文，能识别就输出，不能识别输出空字符串；没有文字块时 blocks 输出 []。',
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
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
    const objectMatch = content.match(/\{[\s\S]*\}/) ?? content.match(/\[[\s\S]*\]/);
    if (!objectMatch) return null;
    const parsed = JSON.parse(objectMatch[0]) as
      | { blocks?: Array<{ x?: number; y?: number; w?: number; h?: number; text?: string }> }
      | Array<{ x?: number; y?: number; w?: number; h?: number; text?: string }>;
    const raw = Array.isArray(parsed) ? parsed : (parsed.blocks ?? []);
    if (!Array.isArray(raw)) return null;
    return raw
      .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y))
      .map((b) => ({
        x: Math.min(1, Math.max(0, Number(b.x))),
        y: Math.min(1, Math.max(0, Number(b.y))),
        w: Math.min(1, Math.max(0.01, Number(b.w ?? 0.08))),
        h: Math.min(1, Math.max(0.01, Number(b.h ?? 0.04))),
        text: String(b.text ?? ''),
      }));
  } catch {
    return null;
  }
}

/**
 * 空框补提取：把该框区域从原图裁出来单独发给视觉对话模型，
 * 输出框内原文。裁剪局部比整图问坐标可靠得多。
 */
export async function extractTextInBox(
  config: { baseUrl: string; apiKey: string; ocrModel: string },
  image: Buffer,
  mime: string,
  box: { x: number; y: number; w: number; h: number },
): Promise<string | null> {
  try {
    const meta = await sharp(image).metadata();
    const left = Math.max(0, Math.round((box.x ?? 0) * (meta.width ?? 1)));
    const top = Math.max(0, Math.round((box.y ?? 0) * (meta.height ?? 1)));
    const width = Math.max(8, Math.round((box.w ?? 0.1) * (meta.width ?? 1)));
    const height = Math.max(8, Math.round((box.h ?? 0.04) * (meta.height ?? 1)));
    const crop = await sharp(image)
      .extract({
        left,
        top,
        width: Math.min(width, Math.max(8, (meta.width ?? width) - left)),
        height: Math.min(height, Math.max(8, (meta.height ?? height) - top)),
      })
      .png()
      .toBuffer();
    const dataUrl = toDataUrl(crop, 'image/png');
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
                text: '这是漫画的一个局部区域。识别区域内所有原文（保持原语言），只输出 JSON 对象，不要任何其它文字：{"text":"原文"}。没有文字时输出 {"text":""}。',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * OpenAI 兼容的图像编辑（/v1/images/edits）：图片 + 蒙版 + 提示词 → 生成式填充。
 * 用于「AI 去字」。注意这是生成式模型，mask 外的像素可能被轻微重绘，
 * 调用方必须做漂移校验（见 inpaint 路由里的 drift 检查）。
 */
export async function imageEditWithMask(
  config: AiConfig,
  image: Buffer,
  mask: Buffer,
  prompt: string,
  size: string,
): Promise<Buffer | null> {
  try {
    const form = new FormData();
    form.append('model', config.imageModel);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append(
      'image',
      new Blob([new Uint8Array(image)], { type: 'image/png' }),
      'image.png',
    );
    form.append('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png');

    const response = await fetch(`${config.baseUrl}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = data.data?.[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item?.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) return null;
      return Buffer.from(await img.arrayBuffer());
    }
    return null;
  } catch {
    return null;
  }
}
