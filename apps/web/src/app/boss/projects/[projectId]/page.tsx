import { OwnerWorkspace } from "../../owner-workspace";

export default async function OwnerProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <OwnerWorkspace projectId={projectId} view="project-detail" />;
}
