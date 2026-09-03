import { NextResponse } from 'next/server';
import {
  detectionConfigured,
  maskKey,
  resolveDetectionConfig,
  writeDetectionConfig,
} from '@/lib/ai';
import { getCurrentUser } from '@/lib/auth';
import { sidecarStatus } from '@/lib/sidecar';

/** 读取当前用户的文本块检测配置（Key 只回尾 4 位）+ 本机检测进程状态 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const config = resolveDetectionConfig(user.id);
  const sidecar = await sidecarStatus();
  return NextResponse.json({
    config: {
      source: config.source,
      baseUrl: config.baseUrl,
      apiKeyMasked: maskKey(config.apiKey),
      model: config.model,
    },
    ready: detectionConfigured(config),
    sidecar: {
      reachable: Boolean(sidecar),
      engine: sidecar?.engine ?? null,
      detector: Boolean(sidecar?.detector),
    },
  });
}

/** 保存检测配置；source='sidecar' 时无需填写三项；apiKey 留空 = 保持不变，'clear' = 清除 */
export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { source?: string; baseUrl?: string; apiKey?: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const source = body.source === 'sidecar' ? 'sidecar' : 'ai';
  const baseUrl = (body.baseUrl ?? '').trim();
  const model = (body.model ?? '').trim();
  const apiKeyInput = body.apiKey?.trim();

  if (source === 'sidecar') {
    // 本机检测进程：无需任何外部配置
    writeDetectionConfig(user.id, { source, baseUrl: '', apiKey: 'clear', model: '' });
    const config = resolveDetectionConfig(user.id);
    return NextResponse.json({ config: { ...config, apiKeyMasked: maskKey(config.apiKey) }, ready: true });
  }

  // 三项齐全才视为启用；只填部分时直接报错，避免出现「看起来配好了其实不工作」的半截配置
  if (baseUrl || model || (apiKeyInput && apiKeyInput !== 'clear')) {
    if (!baseUrl || !model || (!apiKeyInput && !resolveDetectionConfig(user.id).apiKey)) {
      return NextResponse.json(
        { error: 'Base URL、API Key、模型名三项都需填写才能启用检测服务' },
        { status: 400 },
      );
    }
  }
  if (apiKeyInput && apiKeyInput !== 'clear' && apiKeyInput.length < 8) {
    return NextResponse.json({ error: 'API Key 看起来不完整' }, { status: 400 });
  }
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: 'Base URL 需以 http(s):// 开头' }, { status: 400 });
  }

  writeDetectionConfig(user.id, {
    source,
    baseUrl,
    apiKey: apiKeyInput || undefined,
    model,
  });
  const config = resolveDetectionConfig(user.id);
  return NextResponse.json({
    config: {
      source: config.source,
      baseUrl: config.baseUrl,
      apiKeyMasked: maskKey(config.apiKey),
      model: config.model,
    },
    ready: detectionConfigured(config),
  });
}
