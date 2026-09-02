import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { aiConfigured, listProviders, maskKey, resolveAiConfig } from '@/lib/ai';
import { getCurrentUser } from '@/lib/auth';

function cleanProviderInput(body: Record<string, unknown>) {
  return {
    name: String(body.name ?? '').trim().slice(0, 50),
    baseUrl: String(body.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
    ocrModel: String(body.ocrModel ?? '').trim().slice(0, 100),
    chatModel: String(body.chatModel ?? '').trim().slice(0, 100),
    imageModel: String(body.imageModel ?? '').trim().slice(0, 100),
  };
}

/** 列出我的 Provider 列表（key 只回尾 4 位），顺带给出解析后的就绪状态 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const rows = listProviders(user.id);
  const resolved = resolveAiConfig(user.id, 'ocr');
  return NextResponse.json({
    providers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKeyMasked: maskKey(row.api_key),
      ocrModel: row.ocr_model,
      chatModel: row.chat_model,
      imageModel: row.image_model,
      isDefault: row.is_default === 1,
    })),
    ocrReady: aiConfigured(resolved, 'ocr'),
    chatReady: aiConfigured(resolved, 'chat'),
    inpaintReady: aiConfigured(resolved, 'inpaint'),
  });
}

/** 新增一条 Provider；第一条自动设为默认 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const input = cleanProviderInput(body);
  if (!/^https?:\/\//i.test(input.baseUrl)) {
    return NextResponse.json({ error: 'Base URL 必须以 http(s):// 开头' }, { status: 400 });
  }
  if (!input.apiKey.trim()) {
    return NextResponse.json({ error: 'API Key 不能为空' }, { status: 400 });
  }

  const existing = listProviders(user.id);
  const isDefault = existing.length === 0 || body.setDefault === true ? 1 : 0;
  if (isDefault === 1) {
    db.prepare('UPDATE ai_providers SET is_default = 0 WHERE user_id = ?').run(user.id);
  }

  const result = db
    .prepare(
      `INSERT INTO ai_providers (user_id, name, base_url, api_key, ocr_model, chat_model, image_model, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      input.name || `服务 ${existing.length + 1}`,
      input.baseUrl,
      input.apiKey.trim(),
      input.ocrModel,
      input.chatModel,
      input.imageModel,
      isDefault,
    );

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
