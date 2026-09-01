import SpaceDetailClient from './SpaceDetailClient';

export default async function SpaceDetailPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  return <SpaceDetailClient spaceId={Number(spaceId)} />;
}
