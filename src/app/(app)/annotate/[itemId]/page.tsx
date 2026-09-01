import AnnotationEditor from './AnnotationEditor';

export default async function AnnotatePage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { itemId } = await params;
  return <AnnotationEditor itemId={Number(itemId)} />;
}
