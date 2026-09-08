import { OwnerWorkspace } from "../../owner-workspace";

export default async function OwnerApprovalDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <OwnerWorkspace projectId={projectId} view="approval-detail" />;
}
