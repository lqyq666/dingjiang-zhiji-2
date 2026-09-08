import type { ReactNode } from "react";

import { WorkspaceShell } from "../components/vs01-workspace-shell";

export function EmployeeShell({
  children,
  active = "home",
  projectId,
  assistantTaskId,
  assistantRefreshKey,
  title = "我的咨询工作",
}: {
  children: ReactNode;
  active?: "home" | "diagnosis" | "risks" | "projects";
  projectId?: string | null;
  assistantTaskId?: string | null;
  assistantRefreshKey?: number;
  title?: string;
}) {
  return (
    <WorkspaceShell
      active={active}
      projectId={projectId}
      assistantTaskId={assistantTaskId}
      assistantRefreshKey={assistantRefreshKey}
      role="PMC"
      title={title}
    >
      {children}
    </WorkspaceShell>
  );
}
