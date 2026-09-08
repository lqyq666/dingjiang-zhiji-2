"use client";

import Link from "next/link";
import { useState } from "react";
import { useLiveRecord } from "../lib/use-live-record";
import { RecordSync } from "../components/record-sync";
import { getEmployeeDashboard } from "../lib/vs01-api";
import { EmployeeShell } from "./employee-shell";
import { filterWorkRows, workRows, type WorkView } from "./work-queue";
import styles from "./employee-workspace.module.css";

export type EmployeeWorkspaceView = WorkView;
const meta = {
  home: {
    title: "事件台账",
    description:
      "每件事的状态、过程和依据，统一留存在这里。业务操作在 WorkBuddy 完成。",
    table: "事件记录",
    empty: "当前没有待跟进工作",
    active: "home",
  },
  risks: {
    title: "经营异常",
    description: "查看交付风险，核对异常原因与处理记录。",
    table: "异常列表",
    empty: "当前没有经营异常",
    active: "risks",
  },
  projects: {
    title: "项目记录",
    description: "查看处理阶段、责任人和已记录的结果。",
    table: "任务列表",
    empty: "还没有咨询任务",
    active: "projects",
  },
  confirmations: {
    title: "待确认",
    description: "查看仍待相关人员确认的记录。",
    table: "确认队列",
    empty: "当前没有待确认事项",
    active: "diagnosis",
  },
} as const;

export function EmployeeWorkspace({ view }: { view: WorkView }) {
  const live = useLiveRecord(getEmployeeDashboard);
  const dashboard = live.data;
  const error = live.error;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"active" | "all">("all");
  const info = meta[view];
  const rows = dashboard ? workRows(dashboard, view) : [];
  const shown = filterWorkRows(rows, query, scope);
  const from = view === "home" ? "/employee" : `/employee/${view}`;
  return (
    <EmployeeShell active={info.active} title={info.title}>
      <div className={styles.workspace}>
        <header className={styles.heading}>
          <div>
            <h1>{info.title}</h1>
            <p>{info.description}</p>
          </div>
          {dashboard ? (
            <span className={styles.total}>
              {rows.filter((row) => !row.completed).length}{" "}
              <small>项待跟进</small>
            </span>
          ) : null}
        </header>
        <RecordSync {...live} />
        {error && !dashboard ? (
          <div className={styles.error} role="alert">
            <strong>暂时无法读取工作列表</strong>
            <p>{error}</p>
            <button type="button" onClick={live.refresh}>
              重新加载
            </button>
          </div>
        ) : !dashboard ? (
          <div className={styles.loading} role="status">
            正在读取工作列表…
            <span />
            <span />
            <span />
          </div>
        ) : (
          <>
            <section className={styles.tablePanel} aria-label={info.table}>
              <div className={styles.toolbar}>
                {view === "home" || view === "projects" ? (
                  <div className={styles.filters} aria-label="显示范围">
                    <button
                      type="button"
                      aria-pressed={scope === "active"}
                      onClick={() => setScope("active")}
                    >
                      待跟进
                    </button>
                    <button
                      type="button"
                      aria-pressed={scope === "all"}
                      onClick={() => setScope("all")}
                    >
                      全部记录
                    </button>
                  </div>
                ) : (
                  <strong>{info.table}</strong>
                )}
                <label className={styles.search}>
                  <span className={styles.srOnly}>搜索工作</span>
                  <input
                    type="search"
                    placeholder="搜索客户、订单或任务"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              </div>
              <div className={styles.tableScroller}>
                <table className={styles.dataTable}>
                  <caption className={styles.srOnly}>{info.table}</caption>
                  <thead>
                    <tr>
                      <th>
                        {view === "projects" ? "项目 / 来源" : "事件 / 客户"}
                      </th>
                      <th>当前状态</th>
                      <th>{view === "projects" ? "执行进度" : "跟进重点"}</th>
                      <th>记录</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => (
                      <tr key={`${row.type}-${row.id}`}>
                        <td data-label="工作">
                          <div>
                            <strong>{row.title}</strong>
                            <small>{row.context}</small>
                          </div>
                        </td>
                        <td data-label="当前状态">
                          <span
                            className={styles.status}
                            data-tone={
                              row.completed
                                ? "green"
                                : row.pending
                                  ? "blue"
                                  : "neutral"
                            }
                          >
                            {row.status}
                          </span>
                          {view === "home" ? <small>{row.type}</small> : null}
                        </td>
                        <td data-label="跟进重点">
                          {row.progress !== undefined ? (
                            <div className={styles.progress}>
                              <progress
                                value={row.progress}
                                max={100}
                                aria-label={`${row.title}执行进度`}
                              />
                              <span>{row.progress}%</span>
                            </div>
                          ) : (
                            row.detail
                          )}
                        </td>
                        <td data-label="操作">
                          <Link
                            className={styles.rowAction}
                            href={`${row.href}?from=${encodeURIComponent(from)}`}
                          >
                            查看记录
                            <span aria-hidden="true"> →</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!shown.length ? (
                <div className={styles.empty}>
                  <strong>{query ? "没有找到匹配的工作" : info.empty}</strong>
                  <p>
                    {query
                      ? "换一个关键词，或清空搜索查看列表。"
                      : "可以查看全部记录，或到经营异常中核对新的问题。"}
                  </p>
                  {query ? (
                    <button type="button" onClick={() => setQuery("")}>
                      清空搜索
                    </button>
                  ) : (
                    <Link href="/employee/risks">查看经营异常 →</Link>
                  )}
                </div>
              ) : null}
              <footer className={styles.tableFooter} aria-live="polite">
                显示 {shown.length} 项，共 {rows.length} 项
                {view === "risks" ? " · 判断已记录，不代表异常已解决" : ""}
              </footer>
            </section>
          </>
        )}
      </div>
    </EmployeeShell>
  );
}
