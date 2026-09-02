import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { readAvatar } from '@/lib/profile';

type Params = { params: Promise<{ filename: string }> };

/** 头像只对登录用户开放（与其它媒体路由一致） */
export async function GET(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { filename } = await params;
  const image = await readAvatar(filename);
  if (!image) return NextResponse.json({ error: '头像不存在' }, { status: 404 });

  return new NextResponse(new Uint8Array(image), {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
