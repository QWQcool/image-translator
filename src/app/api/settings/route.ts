import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getProgressItems, getPresetTags, saveSiteConfig } from '@/lib/settings';

/** GET /api/settings：进度项与预设标签配置（登录即可读） */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });
  return NextResponse.json({ progressItems: getProgressItems(), presetTags: getPresetTags() });
}

/** PUT /api/settings：整包保存（登录即可写，扁平权限）；任一项清洗不合法 400 */
export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let body: { progressItems?: unknown; presetTags?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }
  // JSON null / 非对象 body 直接 400（解构会抛 TypeError 变 500）
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const { progressItems, presetTags } = saveSiteConfig(body.progressItems, body.presetTags);
  if (!progressItems || !presetTags) {
    return NextResponse.json({ error: '配置格式不合法：进度项必须覆盖内置七态' }, { status: 400 });
  }

  // 返回清洗后的值，前端用服务端结果覆盖本地状态
  return NextResponse.json({ progressItems, presetTags });
}
