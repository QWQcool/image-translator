import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getProvider, listProviders } from '@/lib/ai';
import { getCurrentUser } from '@/lib/auth';

type Params = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 编辑一条 Provider。apiKey 规则与旧配置接口一致：
 * 传空字符串 = 不改动现有 key，传 "clear" = 清除。
 * body.setDefault = true 时同时把该条设为默认。
 */
export async function PATCH(request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const row = getProvider(user.id, id);
  if (!row) return NextResponse.json({ error: '配置不存在' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const name = body.name === undefined ? row.name : String(body.name).trim().slice(0, 50);
  const baseUrl =
    body.baseUrl === undefined ? row.base_url : String(body.baseUrl).trim().replace(/\/+$/, '');
  const ocrModel =
    body.ocrModel === undefined ? row.ocr_model : String(body.ocrModel).trim().slice(0, 100);
  const chatModel =
    body.chatModel === undefined ? row.chat_model : String(body.chatModel).trim().slice(0, 100);
  const imageModel =
    body.imageModel === undefined ? row.image_model : String(body.imageModel).trim().slice(0, 100);

  let apiKey = row.api_key;
  if (typeof body.apiKey === 'string') {
    if (body.apiKey === 'clear') apiKey = '';
    else if (body.apiKey.trim()) apiKey = body.apiKey.trim();
  }

  if (body.baseUrl !== undefined && !/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ error: 'Base URL 必须以 http(s):// 开头' }, { status: 400 });
  }

  const setDefault = body.setDefault === true;
  if (setDefault) {
    db.prepare('UPDATE ai_providers SET is_default = 0 WHERE user_id = ?').run(user.id);
  }

  db.prepare(
    `UPDATE ai_providers
        SET name = ?, base_url = ?, api_key = ?, ocr_model = ?, chat_model = ?, image_model = ?,
            is_default = ?
      WHERE id = ? AND user_id = ?`,
  ).run(
    name || row.name,
    baseUrl,
    apiKey,
    ocrModel,
    chatModel,
    imageModel,
    setDefault ? 1 : row.is_default,
    id,
    user.id,
  );

  return NextResponse.json({ ok: true });
}

/** 删除一条 Provider；删的是默认时自动把剩下第一条升为默认 */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: '参数错误' }, { status: 400 });

  const row = getProvider(user.id, id);
  if (!row) return NextResponse.json({ error: '配置不存在' }, { status: 404 });

  db.prepare('DELETE FROM ai_providers WHERE id = ? AND user_id = ?').run(id, user.id);

  if (row.is_default === 1) {
    const rest = listProviders(user.id);
    if (rest.length > 0) {
      db.prepare('UPDATE ai_providers SET is_default = 1 WHERE id = ?').run(rest[0].id);
    }
  }

  return NextResponse.json({ ok: true });
}
