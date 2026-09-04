import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { DATA_DIR } from '@/lib/db';

const FONTS_DIR = path.join(DATA_DIR, 'fonts');

const FONT_MIME: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** GET /api/fonts/[name] → 字体文件字节流（前端 FontFace 加载用） */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const raw = (await params).name;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 保留原始值（含 % 的文件名不做二次解码）
  }
  const safe = path.basename(decoded);
  const i = safe.lastIndexOf('.');
  const ext = i >= 0 ? safe.slice(i).toLowerCase() : '';
  const mime = FONT_MIME[ext];
  if (!mime) {
    return NextResponse.json({ error: '不支持的字体格式' }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(path.join(FONTS_DIR, safe));
    return new NextResponse(new Uint8Array(buf), {
      headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' },
    });
  } catch {
    return NextResponse.json({ error: '字体不存在' }, { status: 404 });
  }
}
