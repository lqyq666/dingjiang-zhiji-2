import { EmployeeShell } from "../../employee-shell";

export default function Loading() {
  return (
    <EmployeeShell active="risks" title="问题处理">
      <p role="status">正在打开问题详情…</p>
    </EmployeeShell>
  );
}
