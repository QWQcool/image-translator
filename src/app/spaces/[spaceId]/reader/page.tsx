import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import ReaderClient from './ReaderClient';

/** 空间阅读模式（全屏，脱离 (app) 布局以隐藏顶栏） */
export default async function ReaderPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { spaceId } = await params;
  return <ReaderClient spaceId={Number(spaceId)} />;
}
