"use client";
import Link from "next/link";
import { useState } from "react";
import { getBossDashboard } from "../lib/vs01-api";
import { useLiveRecord } from "../lib/use-live-record";
import { WorkspaceShell } from "../components/vs01-workspace-shell";
import { RecordSync } from "../components/record-sync";
import {
  ProjectRecord,
  recordStatus,
  projectRecordStatus,
} from "../components/project-record";
import styles from "../components/records.module.css";

export type OwnerWorkspaceView =
  | "home"
  | "risks"
  | "projects"
  | "project-detail"
  | "approvals"
  | "approval-detail"
  | "data-sources";

function OwnerRecords({ view }: { view: OwnerWorkspaceView }) {
  const live = useLiveRecord(getBossDashboard);
  const dashboard = live.data;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState(view === "approvals" ? "pending" : "all");
  const title =
    view === "risks"
      ? "经营异常"
      : view === "projects"
        ? "项目记录"
        : view === "approvals"
          ? "决策记录"
          : view === "data-sources"
            ? "数据来源"
            : "经营概览";
  const projects =
    dashboard?.projects.filter(
      (p) =>
        (scope !== "pending" || p.status === "PENDING_APPROVAL") &&
        `${p.name} ${p.sourceTaskId}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <WorkspaceShell
      active={
        view === "data-sources"
          ? "dataSources"
          : view === "approvals"
            ? "approval"
            : view === "risks"
              ? "risks"
              : view === "projects"
                ? "projects"
                : "home"
      }
      title={title}
      role="OWNER"
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div>
            <h1>{title}</h1>
            <p>查看事件进展、处理依据和经营结果。</p>
          </div>
          <Link href="/employee">查看全部事件 →</Link>
        </header>
        <RecordSync {...live} />
        {dashboard && (
          <>
            {view === "home" && (
              <section className={styles.section} aria-label="经营指标">
                <dl className={styles.facts}>
                  <div>
                    <dt>预计准交率</dt>
                    <dd>
                      {dashboard.dataSources.some(
                        (source) =>
                          source.category === "ORDER" && source.recordCount > 0,
                      )
                        ? `${dashboard.otd}%`
                        : "暂无订单"}{" "}
                      <small>目标 {dashboard.targetOtd}%</small>
                    </dd>
                  </div>
                  <div>
                    <dt>交付风险</dt>
                    <dd>
                      <Link href="/boss/risks">
                        {dashboard.highRiskOrderCount} 笔订单
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt>待负责人决策</dt>
                    <dd>
                      <Link href="/boss/approvals">
                        {dashboard.pendingApprovalCount} 项
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt>已完成项目</dt>
                    <dd>
                      {
                        dashboard.projects.filter(
                          (p) => p.status === "COMPLETED",
                        ).length
                      }{" "}
                      / {dashboard.projects.length}
                    </dd>
                  </div>
                </dl>
                <p className={styles.muted}>
                  预计准交率依据订单预计交期计算；各项目的实际改善结果单独留存。
                </p>
              </section>
            )}
            {["home", "projects", "approvals"].includes(view) && (
              <section className={styles.section}>
                <h2>{view === "approvals" ? "方案决策状态" : "项目进展"}</h2>
                <div className={styles.toolbar}>
                  <div className={styles.tabs} aria-label="记录范围">
                    <button
                      type="button"
                      aria-pressed={scope === "all"}
                      onClick={() => setScope("all")}
                    >
                      全部记录
                    </button>
                    <button
                      type="button"
                      aria-pressed={scope === "pending"}
                      onClick={() => setScope("pending")}
                    >
                      待负责人决策
                    </button>
                  </div>
                  <input
                    className={styles.search}
                    type="search"
                    aria-label="搜索项目"
                    placeholder="搜索项目或来源事件"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>项目 / 来源事件</th>
                        <th>当前阶段</th>
                        <th>责任人</th>
                        <th>状态</th>
                        <th>实际结果 / 目标</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((p) => {
                        const phase = p.phases.find((item) =>
                          [
                            "READY",
                            "IN_PROGRESS",
                            "WAITING_REVIEW",
                            "RETURNED",
                          ].includes(item.status),
                        );
                        const next = phase?.tasks.find(
                          (t) =>
                            t.origin === "LIVE" &&
                            [
                              "READY",
                              "IN_PROGRESS",
                              "WAITING_REVIEW",
                              "RETURNED",
                            ].includes(t.status),
                        );
                        return (
                          <tr key={p.id}>
                            <td>
                              <Link
                                href={`/boss/projects/${encodeURIComponent(p.id)}`}
                              >
                                <strong>{p.name}</strong>
                              </Link>
                              <small>{p.sourceTaskId}</small>
                            </td>
                            <td>
                              {phase?.name ?? "已结束"}
                              <small>{next?.title ?? ""}</small>
                            </td>
                            <td>{next ? recordStatus[next.owner] : "—"}</td>
                            <td>
                              <span className={styles.status}>
                                {projectRecordStatus(p)}
                              </span>
                            </td>
                            <td>
                              {p.outcome.current === null
                                ? "未记录"
                                : `${p.outcome.current}%`}{" "}
                              / {p.outcome.target}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!projects.length && (
                  <p className={styles.empty}>当前范围没有项目记录。</p>
                )}
              </section>
            )}
            {(view === "risks" || view === "home") && (
              <section className={styles.section}>
                <h2>交付风险</h2>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>订单 / 客户</th>
                        <th>预计延期</th>
                        <th>异常</th>
                        <th>处理状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.highRiskOrders.map((risk) => {
                        const project = dashboard.projects.find(
                          (p) => p.sourceTaskId === risk.orderId,
                        );
                        return (
                          <tr key={risk.orderId}>
                            <td>
                              <Link
                                href={`/employee/task/${encodeURIComponent(risk.orderId)}`}
                              >
                                <strong>{risk.orderId}</strong>
                              </Link>
                              <small>{risk.customer}</small>
                            </td>
                            <td>{risk.delayDays} 天</td>
                            <td>{risk.primaryException}</td>
                            <td>
                              {project ? (
                                <Link
                                  href={`/boss/projects/${encodeURIComponent(project.id)}`}
                                >
                                  {projectRecordStatus(project)}
                                </Link>
                              ) : (
                                "尚未建项"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!dashboard.highRiskOrders.length && (
                  <p className={styles.empty}>当前没有交付风险记录。</p>
                )}
              </section>
            )}
            {view === "data-sources" && (
              <section className={styles.section}>
                <h2>经营数据来源</h2>
                <p className={styles.muted}>
                  每份来源保留版本定位，业务记录通过来源版本追溯。
                </p>
                {dashboard.dataSources.map((source, i) => (
                  <details className={styles.source} key={i}>
                    <summary>{source.fileName}</summary>
                    <pre>{JSON.stringify(source, null, 2)}</pre>
                  </details>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}
export function OwnerWorkspace({
  view,
  projectId,
}: {
  view: OwnerWorkspaceView;
  projectId?: string;
}) {
  if (projectId) return <ProjectRecord key={projectId} id={projectId} owner />;
  return <OwnerRecords view={view} />;
}
