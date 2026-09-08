import { WorkspaceShell } from "../../components/vs01-workspace-shell";

export default function Loading() {
  return (
    <WorkspaceShell active="projects" role="PMC" title="咨询任务">
      <p role="status">正在打开咨询任务…</p>
    </WorkspaceShell>
  );
}
