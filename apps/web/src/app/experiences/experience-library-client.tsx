"use client";
import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { getExperienceLibrary } from "../lib/vs01-api";
import { useLiveRecord } from "../lib/use-live-record";
import { RecordSync } from "../components/record-sync";
import { WorkspaceShell } from "../components/vs01-workspace-shell";
import styles from "../components/records.module.css";
export default function ExperienceLibraryClient() {
  const role =
    useSearchParams().get("role") === "expert" ? "EXPERT_REVIEWER" : "PMC";
  const read = useCallback(() => getExperienceLibrary("", role), [role]);
  const live = useLiveRecord(read);
  const [query, setQuery] = useState("");
  const items =
    live.data?.items.filter((item) =>
      `${item.title} ${item.applicableSituation} ${item.practice}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <WorkspaceShell active="experiences" role={role} title="经验库">
      <div className={styles.page}>
        <header className={styles.heading}>
          <div>
            <h1>经验库</h1>
            <p>已发布的做法、适用条件和结果依据。</p>
          </div>
        </header>
        <RecordSync {...live} />
        <input
          className={styles.search}
          type="search"
          aria-label="搜索经验"
          placeholder="搜索做法或适用场景"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {items.map((item) => (
          <section className={styles.section} key={item.id}>
            <h2>{item.title}</h2>
            <p className={styles.muted}>{item.applicableSituation}</p>
            <h3>做法</h3>
            <p>{item.practice}</p>
            <h3>已记录结果</h3>
            <p>{item.resultSummary}</p>
            <h3>适用限制</h3>
            <p>{item.limitations}</p>
            <details className={styles.source}>
              <summary>查看来源版本</summary>
              <p>{item.evidenceLocator.reference}</p>
              <code>
                {item.locator.sourceVersionId} /{" "}
                {item.evidenceLocator.sourceVersionId}
              </code>
            </details>
          </section>
        ))}
        {live.data && !items.length && (
          <p className={styles.empty}>没有匹配的正式经验。</p>
        )}
      </div>
    </WorkspaceShell>
  );
}
