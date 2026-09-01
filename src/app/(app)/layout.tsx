import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import TopBar from '@/components/TopBar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen">
      <TopBar username={user.username} />
      <main className="mx-auto max-w-[1500px] px-6 py-7">{children}</main>
    </div>
  );
}
