/** Default landing after login/register when `next` is missing or unsafe. */
export const DEFAULT_AFTER_AUTH = '/spaces';

/**
 * Allow only same-origin relative paths. Rejects open redirects such as
 * `//evil.com`, `/\evil.com`, and `https://evil.com`.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const path = value.trim();
  if (!path || path.length > 2048) return null;
  if (!path.startsWith('/')) return null;
  if (path.startsWith('//') || path.startsWith('/\\')) return null;
  if (path.includes('\\') || path.includes('://')) return null;
  if (/[\u0000-\u001F\u007F]/.test(path)) return null;

  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  if (pathname === '/login' || pathname.startsWith('/login/')) return null;
  if (pathname === '/api' || pathname.startsWith('/api/')) return null;
  if (pathname.startsWith('/_next')) return null;

  return path;
}
