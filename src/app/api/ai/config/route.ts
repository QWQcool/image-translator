import { NextResponse } from 'next/server';
import { aiConfigured, maskKey, resolveAiConfig } from '@/lib/ai';
import { getCurrentUser } from '@/lib/auth';

/** 解析后的生效配置状态（默认 Provider 优先，回退旧 ai_configs），供状态徽标展示 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const config = resolveAiConfig(user.id, 'ocr');
  return NextResponse.json({
    config: {
      baseUrl: config.baseUrl,
      apiKeyMasked: maskKey(config.apiKey),
      ocrModel: config.ocrModel,
      chatModel: config.chatModel,
      imageModel: config.imageModel,
    },
    ocrReady: aiConfigured(config, 'ocr'),
    chatReady: aiConfigured(config, 'chat'),
    inpaintReady: aiConfigured(config, 'inpaint'),
  });
}
