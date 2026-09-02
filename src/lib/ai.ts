import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './db';

/**
 * AI 网关配置：创作者填自己的 OpenAI 兼容服务（DeepSeek / GPT / GLM / Qwen…）。
 * 存 data/ai.json（data/ 已在 .gitignore），前端永远拿不到完整 key。
 */
export type AiConfig = {
  /** 例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  /** 视觉对话模型（OCR 用），如 deepseek-v4-flash-vision-exp */
  ocrModel: string;
  /** 图像编辑模型（AI 去字用），如 gpt-image-1；留空 = 不启用 AI 去字 */
  imageModel: string;
};

const AI_PATH = path.join(DATA_DIR, 'ai.json');
const DEFAULTS: AiConfig = { baseUrl: '', apiKey: '', ocrModel: '', imageModel: '' };

export async function readAiConfig(): Promise<AiConfig> {
  try {
    const raw = await fs.readFile(AI_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      baseUrl: String(parsed.baseUrl ?? '').replace(/\/+$/, ''),
      apiKey: String(parsed.apiKey ?? ''),
      ocrModel: String(parsed.ocrModel ?? ''),
      imageModel: String(parsed.imageModel ?? ''),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function writeAiConfig(config: AiConfig): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(AI_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/** 对外只暴露尾 4 位，避免整段 key 泄露到前端 */
export function maskKey(key: string): string {
  if (!key) return '';
  return `****${key.slice(-4)}`;
}

export function aiConfigured(config: AiConfig, which: 'ocr' | 'inpaint'): boolean {
  if (!config.baseUrl || !config.apiKey) return false;
  if (which === 'ocr') return Boolean(config.ocrModel);
  return Boolean(config.imageModel);
}

/** 把 Buffer 包成 OpenAI 视觉接口要的 data URL */
export function toDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
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
