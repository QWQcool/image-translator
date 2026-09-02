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
