'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import HaloMark from './HaloMark';

const NAV = [
  { href: '/spaces', label: '空间' },
  { href: '/library', label: '图库' },
  { href: '/ai', label: 'AI 设置' },
  { href: '/logs', label: '日志' },
];

export default function TopBar({
  username,
  displayName,
  avatarUrl,
}: {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-sky/10 bg-cloud/80 shadow-glass backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1500px] items-center gap-6 px-6">
        <Link href="/spaces" className="flex items-center gap-2 text-ink-100">
          <HaloMark className="h-7 w-7 shrink-0" />
          <span className="font-display text-lg tracking-wide">图译空间</span>
        </Link>

        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? 'bg-sky/10 text-sky-deep'
                    : 'text-ink-400 hover:bg-paper hover:text-ink-200'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <Link
            href="/profile"
            className={`flex items-center gap-2 rounded-lg px-2 py-1 transition-colors ${
              pathname.startsWith('/profile')
                ? 'bg-sky/10'
                : 'hover:bg-paper'
            }`}
            title="个人空间"
          >
            <img
              src={avatarUrl ?? '/mascot/mascot-bust.png'}
              alt=""
              className="h-7 w-7 rounded-full object-cover object-top ring-2 ring-halo/70"
            />
            <span className="hidden text-sm text-ink-400 sm:inline">{displayName}</span>
          </Link>
          <button type="button" onClick={logout} className="btn-ghost px-3 py-1.5 text-xs">
            退出
          </button>
        </div>
      </div>
    </header>
  );
}
