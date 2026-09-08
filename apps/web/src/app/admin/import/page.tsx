"use client";
import Link from "next/link";
import {
  WorkspaceShell,
  workspaceStyles as ui,
} from "../../components/vs01-workspace-shell";
import { useEmployeeSession } from "../../components/session-gate";
export default function ImportPage() {
  const session = useEmployeeSession();
  return (
    <WorkspaceShell active="data" role="PMC" title="企业数据来源">
      <section className={ui.panel}>
        <h1>
          {session.mode === "production" ? "企业数据来源" : "演示数据来源"}
        </h1>
        <p>
          {session.mode === "production"
            ? "本页不接收业务数据，也不显示未经核验的导入记录。管理员需要先完成真实数据接入和来源版本验收；未导入时，工作台应为空。"
            : "演示模式使用 fixtures/vs01 下的脱敏 CSV。演示记录不可作为真实企业事实。"}
        </p>
        <p>
          订单、BOM
          和采购记录需要保留原始材料、来源版本、字段映射、审核责任人和导入结果。网页不会把
          AI 建议直接写成事实。
        </p>
        {session.user?.role === "OWNER" && (
          <Link href="/boss/data-sources">查看已存在的数据来源状态</Link>
        )}
      </section>
    </WorkspaceShell>
  );
}
