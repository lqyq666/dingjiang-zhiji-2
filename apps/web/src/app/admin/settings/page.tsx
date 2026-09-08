import {
  WorkspaceShell,
  workspaceStyles as ui,
} from "../../components/vs01-workspace-shell";

export default function SettingsPage() {
  return (
    <WorkspaceShell active="settings" role="PMC" title="系统设置">
      <section className={ui.panel}>
        <p className={ui.eyebrow}>Admin</p>
        <h1>系统设置</h1>
        <p>
          当前仅展示受控配置边界；Secret、生产身份和业务规则不在浏览器中编辑。
        </p>
      </section>
    </WorkspaceShell>
  );
}
