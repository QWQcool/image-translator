import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { isTrialMode } from '@/lib/trial';
import { DEFAULT_AFTER_AUTH, safeNextPath } from '@/lib/safe-next';
import AuthForm from './AuthForm';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNextPath(next) ?? DEFAULT_AFTER_AUTH;
  // 试用模式（TRIAL_MODE=1，仅限本机体验）：登录/注册页不可达，直接回应用入口。
  // 顶栏「退出」也会落到这里 → 立即被弹回 /spaces（体验用户无法登出，属预期）。
  if (isTrialMode()) {
    redirect('/spaces');
  }
  if (await getCurrentUser()) {
    redirect(dest);
  }
  return <AuthForm nextPath={dest} />;
}
