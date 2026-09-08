"use client";

import { useState } from "react";
import styles from "./records.module.css";

export function WorkBuddyContext({
  projectId,
  taskId,
}: {
  projectId?: string;
  taskId?: string;
}) {
  const [message, setMessage] = useState("");
  const context = projectId
    ? `请读取鼎江项目 ${projectId} 的最新上下文、事项和来源记录，告诉我当前状态及下一步。需要补充的信息只问一次；写入后回读状态并给出回执。涉及人工确认时先展示具体内容，由对应责任人确认。`
    : `请查看鼎江事件 ${taskId} 的事实来源和处理记录，关联已有项目后继续处理；不要重复建项。`;
  return (
    <details className={styles.handoff}>
      <summary>在 WorkBuddy 中继续</summary>
      <p>
        复制这段上下文到 WorkBuddy。具体操作以当前账号可用的工具和权限为准。
      </p>
      <pre>{context}</pre>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(context);
            setMessage("已复制，可粘贴到 WorkBuddy");
          } catch {
            setMessage("复制未成功，请直接选中上方文字复制");
          }
        }}
      >
        复制上下文
      </button>{" "}
      <span role="status">{message}</span>
    </details>
  );
}
