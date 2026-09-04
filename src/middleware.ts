import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/safe-next';

const SESSION_COOKIE = 'tximg_session';

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const incoming = `${pathname}${search}`;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-url-path', incoming);

  if (pathname === '/login' || pathname.startsWith('/login/')) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // 试用模式（TRIAL_MODE=1，仅限本机体验）：登录墙完全放行，所有页面免登录直达。
  // 身份兜底在 server 侧 getCurrentUser()（src/lib/auth.ts → src/lib/trial.ts）。
  // 注意：middleware 运行于 Edge runtime，此环境变量在构建期内联——
  // 体验版构建（.github/workflows/release.yml）会在 npm run build 前设置 TRIAL_MODE=1。
  if (process.env.TRIAL_MODE === '1') {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const session = request.cookies.get(SESSION_COOKIE)?.value;
  if (!session) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    const next = safeNextPath(incoming);
    if (next) loginUrl.searchParams.set('next', next);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|_next/webpack-hmr|favicon.ico|.*\\..*).*)'],
};
