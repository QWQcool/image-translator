import TypesetEditor from './TypesetEditor';

export default async function TypesetPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  return <TypesetEditor itemId={Number(itemId)} />;
}
