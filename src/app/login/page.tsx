import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { DEFAULT_AFTER_AUTH, safeNextPath } from '@/lib/safe-next';
import AuthForm from './AuthForm';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const dest = safeNextPath(next) ?? DEFAULT_AFTER_AUTH;
  if (await getCurrentUser()) {
    redirect(dest);
  }
  return <AuthForm nextPath={dest} />;
}
