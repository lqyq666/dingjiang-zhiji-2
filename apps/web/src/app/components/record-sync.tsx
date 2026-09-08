"use client";

import styles from "./records.module.css";

export function RecordSync({
  error,
  updatedAt,
  refreshing,
  refresh,
}: {
  error: string;
  updatedAt: Date | null;
  refreshing: boolean;
  refresh: () => void;
}) {
  return (
    <div className={styles.sync}>
      <span role={error ? "alert" : "status"}>
        {error
          ? `同步失败${updatedAt ? "，当前显示上次记录" : ""}：${error}`
          : updatedAt
            ? `更新于 ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })} · 每 15 秒同步`
            : "正在读取记录…"}
      </span>
      <button type="button" onClick={refresh} disabled={refreshing}>
        {refreshing ? "同步中…" : "刷新记录"}
      </button>
    </div>
  );
}
