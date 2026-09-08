export const workspaceLayout = {
  nav: { default: 236, min: 184, max: 340, collapsed: 64 },
  assistant: { default: 380, min: 320, max: 560, collapsed: 52 },
  keyboardStep: 16,
} as const;

export type WorkspacePanel = "nav" | "assistant";

export type StoredWorkspaceLayout = {
  navWidth: number;
  assistantWidth: number;
  navCollapsed: boolean;
  assistantCollapsed: boolean;
};

export const defaultWorkspaceLayout: StoredWorkspaceLayout = {
  navWidth: workspaceLayout.nav.default,
  assistantWidth: workspaceLayout.assistant.default,
  navCollapsed: false,
  assistantCollapsed: true,
};

export function clampWorkspacePanel(
  panel: WorkspacePanel,
  width: number,
): number {
  const range = workspaceLayout[panel];
  return Math.min(range.max, Math.max(range.min, Math.round(width)));
}

export function resizeWorkspacePanel(
  panel: WorkspacePanel,
  initialWidth: number,
  pointerDelta: number,
): number {
  const directionalDelta = panel === "nav" ? pointerDelta : -pointerDelta;
  return clampWorkspacePanel(panel, initialWidth + directionalDelta);
}

export function parseWorkspaceLayout(
  value: string | null,
): StoredWorkspaceLayout {
  if (!value) return defaultWorkspaceLayout;
  try {
    const parsed = JSON.parse(value) as Partial<StoredWorkspaceLayout>;
    return {
      navWidth: clampWorkspacePanel(
        "nav",
        typeof parsed.navWidth === "number"
          ? parsed.navWidth
          : workspaceLayout.nav.default,
      ),
      assistantWidth: clampWorkspacePanel(
        "assistant",
        typeof parsed.assistantWidth === "number"
          ? parsed.assistantWidth
          : workspaceLayout.assistant.default,
      ),
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : false,
      assistantCollapsed:
        typeof parsed.assistantCollapsed === "boolean"
          ? parsed.assistantCollapsed
          : true,
    };
  } catch {
    return defaultWorkspaceLayout;
  }
}
