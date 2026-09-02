import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { displayNameOf, getCurrentUser } from '@/lib/auth';
import { safeNextPath } from '@/lib/safe-next';
import TopBar from '@/components/TopBar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    const incoming = (await headers()).get('x-url-path');
    const next = safeNextPath(incoming);
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  }

  return (
    <div className="app-shell min-h-screen">
      <TopBar
        username={user.username}
        displayName={displayNameOf(user)}
        avatarUrl={user.avatar_filename ? `/api/profile/avatar/${user.avatar_filename}` : null}
      />
      <main className="mx-auto max-w-[1500px] px-6 py-7">{children}</main>
    </div>
  );
}
