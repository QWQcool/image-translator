import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AuthForm from './AuthForm';

export default async function LoginPage() {
  if (await getCurrentUser()) {
    redirect('/spaces');
  }
  return <AuthForm />;
}
