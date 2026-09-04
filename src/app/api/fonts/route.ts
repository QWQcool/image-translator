import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { DATA_DIR } from '@/lib/db';
import { logOp } from '@/lib/oplog';

// 自定义字体目录：DATA_DIR/fonts/，文件名（去扩展名）即字体展示名
const FONTS_DIR = path.join(DATA_DIR, 'fonts');
const FONT_EXTS = ['.ttf', '.otf', '.woff', '.woff2'];
const MAX_FONT_BYTES = 30 * 1024 * 1024;

function fontExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

/** 文件名清洗：去路径成分与非法字符，防止目录穿越 */
function sanitizeFontFilename(raw: string): string {
  return path
    .basename(raw)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
}

/** GET /api/fonts → { fonts: [name,...] }（读目录内字体文件名去扩展名，按中文拼音序） */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let names: string[] = [];
  try {
    const entries = await fs.readdir(FONTS_DIR);
    names = entries
      .filter((f) => FONT_EXTS.includes(fontExt(f)))
      .map((f) => f.slice(0, f.length - fontExt(f).length))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch {
    names = [];
  }
  return NextResponse.json({ fonts: names });
}

/**
 * POST /api/fonts（登录即可）：multipart 上传字体文件（字段 file）。
 * 仅接受 .ttf/.otf/.woff/.woff2，≤30MB；重名覆盖并返回 overwritten 提示。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: '请求体格式错误' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: '没有收到字体文件' }, { status: 400 });
  }
  if (file.size > MAX_FONT_BYTES) {
    return NextResponse.json({ error: '字体文件超过 30MB 限制' }, { status: 400 });
  }

  const safeName = sanitizeFontFilename(file.name);
  if (!safeName || !FONT_EXTS.includes(fontExt(safeName))) {
    return NextResponse.json({ error: '仅支持 .ttf / .otf / .woff / .woff2 字体文件' }, { status: 400 });
  }

  await fs.mkdir(FONTS_DIR, { recursive: true });
  const target = path.join(FONTS_DIR, safeName);
  let overwritten = false;
  try {
    await fs.access(target);
    overwritten = true;
  } catch {
    // 文件不存在，正常新增
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(target, buffer);

  const name = safeName.slice(0, safeName.length - fontExt(safeName).length);
  logOp(user.id, 'upload', 'font', null, name, overwritten ? `上传字体（覆盖同名）${safeName}` : `上传字体 ${safeName}`);
  return NextResponse.json({ ok: true, name, overwritten });
}
