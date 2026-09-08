import {
  WorkspaceShell,
  workspaceStyles as ui,
} from "../../components/vs01-workspace-shell";

export default function OrganizationPage() {
  return (
    <WorkspaceShell active="organization" role="PMC" title="组织与权限">
      <section className={ui.panel}>
        <p className={ui.eyebrow}>Human Gate / Admin</p>
        <h1>组织与权限</h1>
        <p>角色、租户和项目权限由服务端身份绑定。本页不允许 AI 提升权限。</p>
      </section>
    </WorkspaceShell>
  );
}
