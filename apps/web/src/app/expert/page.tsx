"use client";
import Link from "next/link";
import { getExpertDashboard } from "../lib/vs01-api";
import { useLiveRecord } from "../lib/use-live-record";
import { RecordSync } from "../components/record-sync";
import { WorkspaceShell } from "../components/vs01-workspace-shell";
import { WorkBuddyContext } from "../components/workbuddy-context";
import styles from "../components/records.module.css";
export default function ExpertPage() {
  const live = useLiveRecord(getExpertDashboard);
  return (
    <WorkspaceShell active="home" role="EXPERT_REVIEWER" title="经验评审记录">
      <div className={styles.page}>
        <header className={styles.heading}>
          <div>
            <h1>经验评审记录</h1>
            <p>查看候选经验及结果依据，评审操作在 WorkBuddy 完成。</p>
          </div>
          <Link href="/experiences?role=expert">正式经验库 →</Link>
        </header>
        <RecordSync {...live} />
        {live.data?.candidates.map(({ candidate, project, outcome }) => (
          <section className={styles.section} key={candidate.id}>
            <h2>{candidate.title}</h2>
            <p>{project.name}</p>
            <h3>已记录做法</h3>
            <p>{candidate.practice}</p>
            <h3>经营结果</h3>
            <p>
              {outcome.current}% · {outcome.conclusion}
            </p>
            <h3>适用限制</h3>
            <p>{candidate.limitations}</p>
            <details className={styles.source}>
              <summary>结果来源</summary>
              <p>{outcome.locator.reference}</p>
              <code>{outcome.locator.sourceVersionId}</code>
            </details>
            <WorkBuddyContext projectId={project.id} />
          </section>
        ))}
        {live.data && !live.data.candidates.length && (
          <p className={styles.empty}>当前没有待评审经验。</p>
        )}
      </div>
    </WorkspaceShell>
  );
}
