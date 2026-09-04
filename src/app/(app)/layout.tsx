import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { displayNameOf, getCurrentUser } from '@/lib/auth';
import { isTrialMode } from '@/lib/trial';
import { safeNextPath } from '@/lib/safe-next';
import TopBar from '@/components/TopBar';
import PageTransition from '@/components/PageTransition';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) {
    const incoming = (await headers()).get('x-url-path');
    const next = safeNextPath(incoming);
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  }

  // 试用模式（TRIAL_MODE=1，仅限本机体验）常驻提示条：amber 底、非阻塞，只提示不拦截。
  // server component 直接读运行时环境变量传给前端，无需客户端状态。
  const trial = isTrialMode();

  return (
    <div className="app-shell min-h-screen">
      {trial && (
        <div className="bg-amber-400 px-4 py-1.5 text-center text-xs font-medium text-ink-950">
          试用模式：数据仅保存在本机 data/ 目录，请勿暴露到公网
        </div>
      )}
      <TopBar
        username={user.username}
        displayName={displayNameOf(user)}
        avatarUrl={user.avatar_filename ? `/api/profile/avatar/${user.avatar_filename}` : null}
      />
      <main className="mx-auto max-w-[1500px] px-6 py-7">
        <PageTransition>{children}</PageTransition>
      </main>
    </div>
  );
}
