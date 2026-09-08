"use client";

import Link from "next/link";
import { useEmployeeSession } from "./session-gate";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  defaultWorkspaceLayout,
  parseWorkspaceLayout,
  resizeWorkspacePanel,
  workspaceLayout,
  type WorkspacePanel,
} from "../lib/workspace-layout";

import ui from "./vs01-workspace.module.css";
import {
  workspaceHrefFor,
  type WorkspaceNavKey,
  type WorkspaceRole,
} from "./workspace-navigation";

type WorkspaceShellProps = {
  active: WorkspaceNavKey;
  children: ReactNode;
  title: string;
  role: WorkspaceRole;
  projectId?: string | null;
  attentionCount?: number;
  assistantTaskId?: string | null;
  assistantRefreshKey?: number;
  assistantPhaseCode?:
    | "PROJECT_SCOPING"
    | "BASELINE_FACTS"
    | "ROOT_CAUSE_VALIDATION"
    | "SOLUTION_APPROVAL"
    | "EXECUTION_CONTROL"
    | "RESULT_ACCEPTANCE"
    | "KNOWLEDGE_CAPTURE";
};

type IconName =
  | "home"
  | "diagnosis"
  | "projects"
  | "data"
  | "book"
  | "approval"
  | "people"
  | "database"
  | "settings"
  | "audit"
  | "menu"
  | "chevron";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    home: <path d="M3 11.5 12 4l9 7.5V21h-6v-6H9v6H3Z" />,
    diagnosis: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m16.2 16.2 4.3 4.3M11 8v3l2 2" />
      </>
    ),
    projects: <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />,
    data: <path d="M4 5h16v14H4zM8 2v6M16 2v6M7 12h10M7 16h6" />,
    book: (
      <path d="M4 5.5A4.5 4.5 0 0 1 8.5 4H12v16H8.5A4.5 4.5 0 0 0 4 21.5Zm16 0A4.5 4.5 0 0 0 15.5 4H12v16h3.5a4.5 4.5 0 0 1 4.5 1.5Z" />
    ),
    approval: <path d="M5 3h14v18H5zM9 8h6M9 12h6m-6 4 2 2 4-5" />,
    people: (
      <path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6m-8 9c-4 0-6 2-6 5v2h12v-2c0-3-2-5-6-5Zm8 0c3 0 5 2 5 5v2h-7" />
    ),
    database: (
      <path d="M4 6c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3Zm0 0v6c0 2 3.6 3 8 3s8-1 8-3V6M4 12v6c0 2 3.6 3 8 3s8-1 8-3v-6" />
    ),
    settings: (
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5 1 3 3 1 3-1 2 3-2 2v3l2 2-2 3-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-3 2-2v-3L-1 9l2-3 3 1 3-1 1-3Z" />
    ),
    audit: <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    chevron: <path d="m9 18 6-6-6-6" />,
  };
  return (
    <svg className={ui.icon} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const primaryNav: Array<{
  key: WorkspaceNavKey;
  label: string;
  icon: IconName;
}> = [
  { key: "home", label: "首页 / 项目总览", icon: "home" },
  { key: "diagnosis", label: "待确认记录", icon: "diagnosis" },
  { key: "risks", label: "经营异常", icon: "diagnosis" },
  { key: "projects", label: "项目记录", icon: "projects" },
  { key: "data", label: "企业数据", icon: "data" },
  { key: "dataSources", label: "数据状态", icon: "data" },
  { key: "experiences", label: "经验库", icon: "book" },
  { key: "approval", label: "决策记录", icon: "approval" },
  { key: "expert", label: "专家审核", icon: "people" },
];

const systemNav: Array<{
  key: WorkspaceNavKey;
  label: string;
  icon: IconName;
}> = [
  { key: "data", label: "数据源", icon: "database" },
  { key: "audit", label: "审计日志", icon: "audit" },
];

const layoutStorageKey = "dingjiang-vs09-workspace-layout";

type WorkspaceLayoutStyle = CSSProperties & {
  "--sidebar-size": string;
  "--assistant-size": string;
};

export function WorkspaceShell({
  active,
  children,
  title,
  role: viewRole,
  projectId,
  attentionCount = 0,
}: WorkspaceShellProps) {
  const session = useEmployeeSession();
  const role = session.user?.role ?? viewRole;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [compactView, setCompactView] = useState(false);
  const pathname = usePathname();
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  const [navWidth, setNavWidth] = useState(defaultWorkspaceLayout.navWidth);
  const [navCollapsed, setNavCollapsed] = useState(
    defaultWorkspaceLayout.navCollapsed,
  );
  const [layoutHydrated, setLayoutHydrated] = useState(false);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(layoutStorageKey);
    } catch {
      /* Private browsing may block storage. */
    }
    const stored = parseWorkspaceLayout(saved);
    setNavWidth(stored.navWidth);
    setNavCollapsed(stored.navCollapsed);
    setLayoutHydrated(true);
  }, []);

  useEffect(() => {
    if (!layoutHydrated) return;
    try {
      window.localStorage.setItem(
        layoutStorageKey,
        JSON.stringify({
          navWidth,
          assistantWidth: defaultWorkspaceLayout.assistantWidth,
          navCollapsed,
          assistantCollapsed: true,
        }),
      );
    } catch {
      /* Layout remains usable without persistence. */
    }
  }, [layoutHydrated, navCollapsed, navWidth]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && drawerOpen) {
        setDrawerOpen(false);
        mobileMenuRef.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [drawerOpen]);

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 899px)");
    setCompactView(compact.matches);
    const collapseForCompactView = (event: MediaQueryListEvent) => {
      setCompactView(event.matches);
      setDrawerOpen(false);
    };
    compact.addEventListener("change", collapseForCompactView);
    return () => compact.removeEventListener("change", collapseForCompactView);
  }, []);

  const setPanelWidth = (panel: WorkspacePanel, width: number) => {
    if (panel === "nav") setNavWidth(width);
  };

  const togglePanel = (panel: WorkspacePanel) => {
    if (panel === "nav") setNavCollapsed((current) => !current);
  };

  const closeMobileDrawer = () => {
    setDrawerOpen(false);
    window.requestAnimationFrame(() => mobileMenuRef.current?.focus());
  };

  const startPanelResize = (
    panel: WorkspacePanel,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    resizeCleanup.current?.();
    if (panel === "nav" && navCollapsed) setNavCollapsed(false);
    const initialPointer = event.clientX;
    const initialWidth = navWidth;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      setPanelWidth(
        panel,
        resizeWorkspacePanel(
          panel,
          initialWidth,
          moveEvent.clientX - initialPointer,
        ),
      );
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.documentElement.classList.remove("vs01-is-resizing");
      resizeCleanup.current = null;
    };
    resizeCleanup.current = finish;
    document.documentElement.classList.add("vs01-is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resizeWithKeyboard = (
    panel: WorkspacePanel,
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      setPanelWidth(panel, workspaceLayout[panel].min);
      return;
    }
    if (event.key === "End") {
      setPanelWidth(panel, workspaceLayout[panel].max);
      return;
    }
    const pointerDelta =
      event.key === "ArrowRight"
        ? workspaceLayout.keyboardStep
        : -workspaceLayout.keyboardStep;
    setPanelWidth(panel, resizeWorkspacePanel(panel, navWidth, pointerDelta));
  };

  const shellStyle: WorkspaceLayoutStyle = {
    "--sidebar-size": `${
      navCollapsed ? workspaceLayout.nav.collapsed : navWidth
    }px`,
    "--assistant-size": `${workspaceLayout.assistant.collapsed}px`,
  };
  const roleName =
    role === "OWNER"
      ? "企业负责人"
      : role === "EXPERT_REVIEWER"
        ? "评审专家"
        : "项目负责人";
  const roleCaption =
    role === "OWNER"
      ? "企业负责人"
      : role === "EXPERT_REVIEWER"
        ? "资深专家"
        : "企业绩效咨询师";

  return (
    <div className={ui.shell} style={shellStyle}>
      <a className="skip" href="#vs01-main">
        跳到主要内容
      </a>
      <aside
        id="vs01-primary-nav"
        inert={compactView && !drawerOpen}
        className={`${ui.sidebar} ${drawerOpen ? ui.sidebarOpen : ""} ${navCollapsed ? ui.sidebarCollapsed : ""}`}
        aria-label="主工作台导航"
      >
        <Link
          className={ui.brand}
          aria-label="鼎江智绩 2.0 首页"
          href={
            role === "OWNER"
              ? "/boss"
              : role === "EXPERT_REVIEWER"
                ? "/expert"
                : "/employee"
          }
        >
          <span className={ui.brandMark} aria-hidden="true">
            <i />
            <b />
            <em />
          </span>
          <strong>鼎江智绩 2.0</strong>
        </Link>
        <div className={ui.company}>
          <span className={ui.companyMark}>企</span>
          <span>{session.companyName}</span>
        </div>
        <nav className={ui.nav} aria-label="主导航">
          {primaryNav
            .filter((item) => {
              if (role === "EXPERT_REVIEWER")
                return ["home", "experiences"].includes(item.key);
              if (role === "OWNER")
                return ["home", "risks", "projects", "approval"].includes(
                  item.key,
                );
              return ["home", "risks", "projects", "experiences"].includes(
                item.key,
              );
            })
            .map((item) => {
              const href = workspaceHrefFor(item.key, role, projectId);
              const label =
                item.key === "home" && role !== "EXPERT_REVIEWER"
                  ? role === "OWNER"
                    ? "经营概览"
                    : "事件台账"
                  : item.label;
              const className = `${ui.navItem} ${active === item.key ? ui.navActive : ""}`;
              return href ? (
                <Link
                  key={item.key}
                  className={className}
                  href={href}
                  aria-label={label}
                  aria-current={active === item.key ? "page" : undefined}
                  title={navCollapsed ? label : undefined}
                  onClick={closeMobileDrawer}
                >
                  <Icon name={item.icon} />
                  <span>{label}</span>
                  {item.key === "approval" &&
                  role === "OWNER" &&
                  attentionCount > 0 ? (
                    <>
                      <i className={ui.navDot} aria-hidden="true" />
                      <span className={ui.srOnly}>
                        {attentionCount} 项待审批
                      </span>
                    </>
                  ) : null}
                </Link>
              ) : (
                <span
                  key={item.key}
                  className={`${className} ${ui.navDisabled}`}
                  aria-disabled="true"
                  title="建立咨询任务后可进入"
                >
                  <Icon name={item.icon} />
                  <span>{label}</span>
                </span>
              );
            })}
        </nav>
        {role === "OWNER" ? (
          <>
            <div className={ui.systemLabel}>经营数据</div>
            <nav className={ui.nav} aria-label="经营数据">
              <Link
                className={`${ui.navItem} ${active === "dataSources" ? ui.navActive : ""}`}
                href="/boss/data-sources"
                aria-current={active === "dataSources" ? "page" : undefined}
                onClick={closeMobileDrawer}
              >
                <Icon name="data" />
                <span>数据状态</span>
              </Link>
            </nav>
          </>
        ) : null}
        {role === "PMC" ? (
          <details
            className={ui.managementNav}
            open={systemNav.some((item) => item.key === active)}
          >
            <summary title="管理工具">管理工具</summary>
            <nav className={ui.nav} aria-label="系统管理">
              {systemNav.map((item) => (
                <Link
                  key={item.label}
                  className={`${ui.navItem} ${active === item.key ? ui.navActive : ""}`}
                  href={workspaceHrefFor(item.key, role, projectId) ?? "/"}
                  aria-current={active === item.key ? "page" : undefined}
                  onClick={closeMobileDrawer}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>
          </details>
        ) : null}
      </aside>
      <div
        className={ui.panelResizer}
        data-panel="nav"
        role="separator"
        aria-label="调整导航栏宽度"
        aria-orientation="vertical"
        aria-valuemin={workspaceLayout.nav.min}
        aria-valuemax={workspaceLayout.nav.max}
        aria-valuenow={navWidth}
        tabIndex={0}
        onDoubleClick={() => togglePanel("nav")}
        onPointerDown={(event) => startPanelResize("nav", event)}
        onKeyDown={(event) => resizeWithKeyboard("nav", event)}
      />
      {drawerOpen ? (
        <button
          className={ui.scrim}
          type="button"
          aria-label="关闭导航"
          onClick={closeMobileDrawer}
        />
      ) : null}
      <div className={ui.appMain}>
        <header className={ui.topbar}>
          <button
            ref={mobileMenuRef}
            className={`${ui.iconButton} ${ui.mobileMenu}`}
            type="button"
            aria-label="打开导航"
            aria-expanded={drawerOpen}
            aria-controls="vs01-primary-nav"
            onClick={() => {
              setNavCollapsed(false);
              setDrawerOpen(true);
            }}
          >
            <Icon name="menu" />
          </button>
          <button
            className={`${ui.iconButton} ${ui.desktopPanelToggle}`}
            type="button"
            aria-label={navCollapsed ? "展开导航栏" : "折叠导航栏"}
            title={navCollapsed ? "展开导航栏" : "折叠导航栏"}
            data-collapsed={navCollapsed}
            onClick={() => togglePanel("nav")}
          >
            <Icon name="chevron" />
          </button>
          <div className={ui.pageTitle}>{title}</div>
          {(session.mode === "demo" || role === "OWNER") && (
            <Link href="/boss">经营概览</Link>
          )}
          {(session.mode === "demo" || role !== "EXPERT_REVIEWER") && (
            <Link href="/employee">事件台账</Link>
          )}
          {session.mode === "production" && (
            <button type="button" onClick={() => void session.logout()}>
              退出登录
            </button>
          )}
          <div className={ui.user}>
            <div>
              <strong>{session.user?.displayName ?? roleName}</strong>
              {roleCaption !== roleName && <small>{roleCaption}</small>}
            </div>
            <span className={ui.avatar}>
              {role === "OWNER"
                ? "企"
                : role === "EXPERT_REVIEWER"
                  ? "专"
                  : "项"}
            </span>
          </div>
        </header>
        <main id="vs01-main" className={ui.workspace}>
          {children}
        </main>
      </div>
    </div>
  );
}

export { ui as workspaceStyles };
