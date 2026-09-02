import { NextResponse } from 'next/server';
import { aiConfigured, resolveAiConfig } from '@/lib/ai';
import { getCurrentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { itemDisplayName, logOp } from '@/lib/oplog';
import { accessError, getSpaceAccess } from '@/lib/permissions';

type Params = { params: Promise<{ id: string }> };

type TranslateProposal = { id: number; source_text: string; translated: string };

/**
 * 6b AI 翻译：把该条目所有标号的 source_text 连同 ai_context（6c 图像解析）作为上下文，
 * 发给对话模型，返回每条译文的 proposals。
 * 不直接写库——前端弹层逐条预览、可改、勾选后走采纳接口写入 pin.text。
 */
export async function POST(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const itemId = Number((await params).id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  const item = db
    .prepare('SELECT space_id, ai_context FROM space_items WHERE id = ?')
    .get(itemId) as { space_id: number; ai_context: string | null } | undefined;
  const denied = accessError(item ? getSpaceAccess(item.space_id, user.id) : null, 'edit');
  if (denied || !item) return denied ?? NextResponse.json({ error: '条目不存在' }, { status: 404 });

  let body: { providerId?: number };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const pins = db
    .prepare(
      `SELECT id, source_text FROM annotations
        WHERE item_id = ? AND kind = 'pin' AND source_text <> ''
        ORDER BY order_index, id`,
    )
    .all(itemId) as Array<{ id: number; source_text: string }>;

  if (pins.length === 0) {
    return NextResponse.json(
      { error: '没有可翻译的原文：请先做 OCR 识别并采纳（或在标号里填写原文）' },
      { status: 400 },
    );
  }

  const config = resolveAiConfig(user.id, 'chat', body.providerId);
  if (!aiConfigured(config, 'chat')) {
    return NextResponse.json(
      { error: 'AI 翻译未就绪：请到「AI 设置」配置 OpenAI 兼容服务与对话模型' },
      { status: 503 },
    );
  }

  // 组装对话上下文：图片内容描述 + 全部原文（含彼此的顺序，帮助模型理解剧情连贯性）
  const contextLines: string[] = [];
  if (item.ai_context) {
    contextLines.push(`图片内容描述：${item.ai_context}`);
  }
  const sourceList = pins.map((pin) => ({ id: pin.id, text: pin.source_text }));

  let translated: Record<number, string> = {};
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.chatModel || config.ocrModel,
        messages: [
          {
            role: 'system',
            content:
              '你是专业的漫画翻译。把给定的台词原文翻译成简体中文口语，保持语气与人物性格，' +
              '译文尽量简短适合对话气泡。只输出 JSON 数组，不要任何其它文字：' +
              '[{"id":原文id,"translated":"译文"}]，id 必须与输入一一对应。',
          },
          {
            role: 'user',
            content: `${contextLines.join('\n')}\n原文列表：${JSON.stringify(sourceList)}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      return NextResponse.json({ error: `AI 翻译调用失败（HTTP ${response.status}）` }, { status: 502 });
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) {
      return NextResponse.json({ error: 'AI 返回的内容无法解析为译文列表' }, { status: 502 });
    }
    const parsed = JSON.parse(match[0]) as Array<{ id?: number; translated?: string }>;
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (Number.isInteger(row.id) && typeof row.translated === 'string') {
          translated[Number(row.id)] = row.translated;
        }
      }
    }
  } catch {
    return NextResponse.json({ error: 'AI 翻译调用失败（网络超时或服务不可用）' }, { status: 502 });
  }

  const proposals: TranslateProposal[] = pins.map((pin) => ({
    id: pin.id,
    source_text: pin.source_text,
    translated: translated[pin.id] ?? '',
  }));

  logOp(
    user.id,
    'ai_translate',
    'ai',
    itemId,
    itemDisplayName(itemId),
    `AI 翻译，生成 ${proposals.length} 条译文建议`,
  );

  return NextResponse.json({ proposals, context: item.ai_context });
}
