import {
  WorkspaceShell,
  workspaceStyles as ui,
} from "../../components/vs01-workspace-shell";

export default function AuditPage() {
  return (
    <WorkspaceShell active="audit" role="PMC" title="审计日志">
      <section className={ui.panel}>
        <p className={ui.eyebrow}>Audit</p>
        <h1>审计日志</h1>
        <p>
          正式审计由 PostgreSQL 的追加式 Audit
          记录提供；此入口不覆盖或删除历史。
        </p>
      </section>
    </WorkspaceShell>
  );
}
