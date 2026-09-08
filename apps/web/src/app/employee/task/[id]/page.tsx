"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import { WorkspaceShell } from "../../../components/vs01-workspace-shell";
import { getTask, getEmployeeDashboard } from "../../../lib/vs01-api";
import { useLiveRecord } from "../../../lib/use-live-record";
import { RecordSync } from "../../../components/record-sync";
import { WorkBuddyContext } from "../../../components/workbuddy-context";
import { recordStatus } from "../../../components/project-record";
import styles from "../../../components/records.module.css";

function EventRecord({ id }: { id: string }) {
  const read = useCallback(async () => {
    const [task, dashboard] = await Promise.all([
      getTask(id),
      getEmployeeDashboard(),
    ]);
    return {
      task,
      project: dashboard.projects.find((p) => p.sourceTaskId === id),
    };
  }, [id]);
  const live = useLiveRecord(read);
  const [section, setSection] = useState("facts");
  const task = live.data?.task;
  const project = live.data?.project;
  return (
    <WorkspaceShell active="home" title="事件记录" role="PMC">
      <div className={styles.page}>
        <header className={styles.heading}>
          <div>
            <Link href="/employee">← 返回事件台账</Link>
            <h1>{task ? `${task.order.customer} · ${task.id}` : "事件记录"}</h1>
            <p>
              {task
                ? `${task.order.primaryException} · ${recordStatus[task.status] ?? task.status}`
                : "读取事实和过程记录"}
            </p>
          </div>
          {project && (
            <Link href={`/project/${encodeURIComponent(project.id)}`}>
              查看处理过程 →
            </Link>
          )}
        </header>
        <RecordSync {...live} />
        {task && (
          <>
            <section className={styles.section}>
              <dl className={styles.facts}>
                <div>
                  <dt>承诺交付日期</dt>
                  <dd>{task.order.promisedDate}</dd>
                </div>
                <div>
                  <dt>预计交付日期</dt>
                  <dd>{task.order.forecastDate}</dd>
                </div>
                <div>
                  <dt>预计延期</dt>
                  <dd>{task.order.delayDays} 天</dd>
                </div>
                <div>
                  <dt>关联项目</dt>
                  <dd>
                    {project ? (
                      <Link href={`/project/${encodeURIComponent(project.id)}`}>
                        {project.name}
                      </Link>
                    ) : (
                      "尚未建项"
                    )}
                  </dd>
                </div>
              </dl>
            </section>
            <nav className={styles.tabs} aria-label="事件记录分类">
              {[
                ["facts", "事实与来源"],
                ["materials", "材料记录"],
                ["decision", "判断记录"],
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
            {section === "facts" && (
              <section className={styles.section}>
                <h2>已记录事实</h2>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>事实</th>
                        <th>记录值</th>
                        <th>依据</th>
                      </tr>
                    </thead>
                    <tbody>
                      {task.facts.map((fact) => (
                        <tr key={`${fact.label}-${fact.evidenceId}`}>
                          <td>{fact.label}</td>
                          <td>{fact.value}</td>
                          <td>
                            <a href={`#evidence-${fact.evidenceId}`}>
                              查看来源
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {task.evidence.map((evidence) => (
                  <details
                    className={styles.source}
                    key={evidence.id}
                    id={`evidence-${evidence.id}`}
                  >
                    <summary>
                      {evidence.claim || evidence.sourceFile} ·{" "}
                      {evidence.classification === "FACT"
                        ? "事实记录"
                        : "待核验提案"}
                    </summary>
                    <p>
                      {evidence.sourceFile} / {evidence.sourceSheet} / 第{" "}
                      {evidence.sourceRow} 行
                    </p>
                    <pre>
                      {evidence.exactSpan?.exactText ||
                        Object.entries(evidence.fields)
                          .map(([key, value]) => `${key}：${value}`)
                          .join("\n")}
                    </pre>
                    <code>来源版本：{evidence.sourceVersionId}</code>
                    {evidence.limitations && (
                      <p>适用限制：{evidence.limitations}</p>
                    )}
                  </details>
                ))}
              </section>
            )}
            {section === "materials" && (
              <section className={styles.section}>
                <h2>材料与核验记录</h2>
                {!task.materials.length && (
                  <p className={styles.empty}>
                    暂无补充材料。材料登记在 WorkBuddy 完成后显示在这里。
                  </p>
                )}
                {task.materials.map((material) => (
                  <details className={styles.source} key={material.id}>
                    <summary>
                      {material.title} ·{" "}
                      {material.status === "WITHDRAWN"
                        ? "已撤回"
                        : recordStatus[material.verification.status]}
                    </summary>
                    <p>{material.note || material.sourceReference}</p>
                    {material.file?.contentPreview && (
                      <pre>{material.file.contentPreview}</pre>
                    )}
                    <p>
                      登记于{" "}
                      {new Date(material.createdAt).toLocaleString("zh-CN")}
                    </p>
                    <p>{material.verification.note || "暂无人工核验记录"}</p>
                    {material.withdrawnReason && (
                      <p>撤回原因：{material.withdrawnReason}</p>
                    )}
                    {material.locator && (
                      <code>来源版本：{material.locator.sourceVersionId}</code>
                    )}
                  </details>
                ))}
              </section>
            )}
            {section === "decision" && (
              <section className={styles.section}>
                <h2>判断记录</h2>
                <p>
                  {task.decision
                    ? {
                        CONFIRMED: "已确认初步判断",
                        MODIFIED: "已调整判断",
                        INSUFFICIENT_INFORMATION: "信息不足，待补充",
                      }[task.decision.type]
                    : "尚无人工判断"}
                </p>
                {task.decision && (
                  <>
                    <p>{task.decision.note}</p>
                    <p className={styles.muted}>
                      记录于{" "}
                      {new Date(task.decision.decidedAt).toLocaleString(
                        "zh-CN",
                      )}
                    </p>
                  </>
                )}
                <details className={styles.source}>
                  <summary>候选原因 · 尚待核验</summary>
                  <p>{task.analysis.candidateCause}</p>
                  <p className={styles.muted}>
                    候选分析不代表已确认的事实或根因。
                  </p>
                </details>
              </section>
            )}
            <WorkBuddyContext taskId={id} projectId={project?.id} />
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}
export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  return <EventRecord key={id} id={id} />;
}
