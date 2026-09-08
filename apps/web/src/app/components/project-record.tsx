"use client";

import Link from "next/link";
import type { Project } from "@dingjiang/contracts";
import { useCallback, useState } from "react";
import { getProject } from "../lib/vs01-api";
import { useLiveRecord } from "../lib/use-live-record";
import { WorkspaceShell } from "./vs01-workspace-shell";
import { RecordSync } from "./record-sync";
import { WorkBuddyContext } from "./workbuddy-context";
import styles from "./records.module.css";

export const recordStatus: Record<string, string> = {
  DRAFT: "方案准备中",
  PENDING_APPROVAL: "待负责人确认",
  RETURNED: "待补充调整",
  RUNNING: "执行中",
  RESULT_VALIDATION: "结果核验中",
  PENDING_RESULT_ACCEPTANCE: "结果待确认",
  KNOWLEDGE_CAPTURE: "经验整理中",
  COMPLETED: "已完成",
  DONE: "已完成",
  READY: "待处理",
  IN_PROGRESS: "处理中",
  WAITING_REVIEW: "待确认",
  LOCKED: "尚未开始",
  NOT_MEASURED: "尚未核验",
  ACCEPTED: "已确认",
  PENDING: "待确认",
  OPEN: "待处理",
  DECIDED: "判断已记录",
  APPROVED: "已确认",
  WITHDRAWN: "已撤回",
  UNVERIFIED: "待核验",
  VERIFIED: "已核验",
  NEEDS_REVISION: "待补充",
  PMC: "项目负责人",
  OWNER: "企业负责人",
  EXPERT_REVIEWER: "评审专家",
};

export const projectRecordStatus = (project: Project) =>
  project.status === "DRAFT" &&
  project.phases.some(
    (phase) =>
      phase.code === "ROOT_CAUSE_VALIDATION" &&
      ["READY", "IN_PROGRESS"].includes(phase.status),
  )
    ? "原因核验中"
    : recordStatus[project.status];

export function ProjectRecord({
  id,
  owner = false,
}: {
  id: string;
  owner?: boolean;
}) {
  const read = useCallback(
    () => getProject(id, owner ? "OWNER" : "PMC"),
    [id, owner],
  );
  const live = useLiveRecord(read);
  const project = live.data;
  const [section, setSection] = useState("process");
  return (
    <WorkspaceShell
      active="projects"
      title="项目记录"
      role={owner ? "OWNER" : "PMC"}
    >
      <div className={styles.page}>
        <header className={styles.heading}>
          <div>
            <Link href={owner ? "/boss/projects" : "/employee"}>
              ← 返回记录列表
            </Link>
            <h1>{project?.name ?? "项目记录"}</h1>
            <p>
              {project
                ? `${projectRecordStatus(project)} · 来源事件 ${project.sourceTaskId}`
                : "读取项目的处理过程与结果"}
            </p>
          </div>
          {project && (
            <Link
              href={`/employee/task/${encodeURIComponent(project.sourceTaskId)}`}
            >
              查看事实来源 →
            </Link>
          )}
        </header>
        <RecordSync {...live} />
        {project && (
          <>
            <section className={styles.section} aria-label="项目状态">
              <dl className={styles.facts}>
                <div>
                  <dt>当前阶段</dt>
                  <dd>
                    {project.phases.find((p) =>
                      [
                        "READY",
                        "IN_PROGRESS",
                        "WAITING_REVIEW",
                        "RETURNED",
                      ].includes(p.status),
                    )?.name ?? "流程已结束"}
                  </dd>
                </div>
                <div>
                  <dt>执行事项完成率</dt>
                  <dd>{project.progress}%</dd>
                </div>
                <div>
                  <dt>实际准交率</dt>
                  <dd>
                    {project.outcome.current === null
                      ? "尚未记录"
                      : `${project.outcome.current}%`}
                  </dd>
                </div>
                <div>
                  <dt>准交率目标</dt>
                  <dd>{project.metric.target}%</dd>
                </div>
              </dl>
            </section>
            <nav className={styles.tabs} aria-label="项目记录分类">
              {[
                ["process", "处理过程"],
                ["result", "经营结果"],
                ["history", "变更记录"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={section === key}
                  onClick={() => setSection(key!)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {section === "process" &&
              project.phases.map((phase) => (
                <details
                  className={styles.section}
                  key={phase.code}
                  open={[
                    "READY",
                    "IN_PROGRESS",
                    "WAITING_REVIEW",
                    "RETURNED",
                  ].includes(phase.status)}
                >
                  <summary className={styles.phaseSummary}>
                    {phase.name}{" "}
                    <span className={styles.status}>
                      {phase.completedTaskCount} / {phase.totalTaskCount} 项完成
                    </span>
                  </summary>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>事项</th>
                          <th>责任人</th>
                          <th>状态</th>
                          <th>最新记录 / 产出</th>
                        </tr>
                      </thead>
                      <tbody>
                        {phase.tasks.map((task) => (
                          <tr key={task.id}>
                            <td>
                              <strong>{task.title}</strong>
                              <small>
                                {task.origin === "HISTORICAL"
                                  ? "历史记录"
                                  : task.purpose}
                              </small>
                            </td>
                            <td>{recordStatus[task.owner]}</td>
                            <td>
                              <span className={styles.status}>
                                {recordStatus[task.status] ?? task.status}
                              </span>
                            </td>
                            <td>
                              {task.output.reference ||
                                task.progressUpdate?.note ||
                                task.completionNote ||
                                "暂无记录"}
                              {task.completionConfirmation && (
                                <small>
                                  确认人：
                                  {recordStatus[
                                    task.completionConfirmation.confirmedBy
                                  ] ?? task.completionConfirmation.confirmedBy}
                                </small>
                              )}
                              {task.output.locator && (
                                <details className={styles.source}>
                                  <summary>来源版本</summary>
                                  <code>
                                    {task.output.locator.sourceVersionId}
                                  </code>
                                </details>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            {section === "result" && (
              <section className={styles.section}>
                <h2>准交率结果</h2>
                <dl className={styles.facts}>
                  <div>
                    <dt>改善前</dt>
                    <dd>{project.outcome.baseline}%</dd>
                  </div>
                  <div>
                    <dt>已记录结果</dt>
                    <dd>
                      {project.outcome.current === null
                        ? "尚未记录"
                        : `${project.outcome.current}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>目标</dt>
                    <dd>{project.outcome.target}%</dd>
                  </div>
                  <div>
                    <dt>结果状态</dt>
                    <dd>
                      {recordStatus[project.outcome.status] ??
                        project.outcome.status}
                    </dd>
                  </div>
                </dl>
                <p>{project.outcome.conclusion || "暂无结果结论"}</p>
                <p className={styles.muted}>
                  {project.outcome.evidenceReference || "暂无结果依据"}
                </p>
                {project.outcome.locator && (
                  <details className={styles.source}>
                    <summary>查看结果来源版本</summary>
                    <code>{project.outcome.locator.sourceVersionId}</code>
                  </details>
                )}
              </section>
            )}
            {section === "history" && (
              <section className={styles.section}>
                <h2>变更记录</h2>
                <ol className={styles.timeline}>
                  {[...project.auditTrail].reverse().map((event, i) => (
                    <li key={`${event.createdAt}-${i}`}>
                      <time>
                        {new Date(event.createdAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      </time>
                      <div>
                        <strong>
                          {recordStatus[event.actor] ?? event.actor}
                          {event.phaseCode
                            ? ` · ${project.phases.find((p) => p.code === event.phaseCode)?.name ?? "项目"}`
                            : ""}
                        </strong>
                        <p>{event.note || "状态变更已记录"}</p>
                        <details className={styles.source}>
                          <summary>追溯记录</summary>
                          <code>{event.eventType}</code>
                          <pre>{JSON.stringify(event.snapshot, null, 2)}</pre>
                        </details>
                      </div>
                    </li>
                  ))}
                </ol>
                {!project.auditTrail.length && (
                  <p className={styles.empty}>暂无变更记录</p>
                )}
              </section>
            )}
            <WorkBuddyContext projectId={project.id} />
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}
