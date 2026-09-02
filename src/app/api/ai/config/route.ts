import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  aiConfigured,
  maskKey,
  readAiConfig,
  writeAiConfig,
  type AiConfig,
} from '@/lib/ai';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const config = await readAiConfig();
  return NextResponse.json({
    config: {
      baseUrl: config.baseUrl,
      apiKeyMasked: maskKey(config.apiKey),
      ocrModel: config.ocrModel,
      imageModel: config.imageModel,
    },
    ocrReady: aiConfigured(config, 'ocr'),
    inpaintReady: aiConfigured(config, 'inpaint'),
  });
}

/**
 * 保存配置。apiKey 传空字符串 = 不改动现有 key，传 "clear" = 清除。
 * 开放空间：任何登录用户都能配置（互相认识的团队）。
 */
export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: {
    baseUrl?: string;
    apiKey?: string;
    ocrModel?: string;
    imageModel?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const current = await readAiConfig();
  const baseUrl = (body.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, '');
  const ocrModel = (body.ocrModel ?? current.ocrModel).trim();
  const imageModel = (body.imageModel ?? current.imageModel).trim();

  let apiKey = current.apiKey;
  if (body.apiKey === 'clear') apiKey = '';
  else if (body.apiKey && body.apiKey.trim()) apiKey = body.apiKey.trim();

  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: 'Base URL 必须以 http(s):// 开头' }, { status: 400 });
  }

  const config: AiConfig = { baseUrl, apiKey, ocrModel, imageModel };
  await writeAiConfig(config);

  return NextResponse.json({
    config: {
      baseUrl,
      apiKeyMasked: maskKey(apiKey),
      ocrModel,
      imageModel,
    },
    ocrReady: aiConfigured(config, 'ocr'),
    inpaintReady: aiConfigured(config, 'inpaint'),
  });
}
