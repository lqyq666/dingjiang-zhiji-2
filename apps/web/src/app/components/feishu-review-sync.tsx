"use client";

import { useId, useState } from "react";
import type {
  FeishuPullReceipt,
  FeishuPushReceipt,
} from "@dingjiang/contracts";

import {
  pullFeishuExperienceReviews,
  pushExperienceCandidateToFeishu,
} from "../lib/vs17-api";
import styles from "./vs17-experience.module.css";

const newRequestId = () => crypto.randomUUID();

type PersistedFeishuSync = {
  status: "PENDING" | "SYNCED" | "FAILED" | null;
  recordId: string | null;
  revision: number | null;
  syncedAt: string | null;
};

export function FeishuReviewSync({
  candidateId,
  expectedCandidateVersionId,
  onSynced,
  onPulled,
  onLocalReview,
  sync,
}: {
  candidateId: string;
  expectedCandidateVersionId: string;
  onSynced?: (receipt: FeishuPushReceipt) => Promise<void> | void;
  onPulled?: (receipt: FeishuPullReceipt) => Promise<void> | void;
  onLocalReview?: () => Promise<void> | void;
  sync?: PersistedFeishuSync | null;
}) {
  const headingId = useId();
  const [pushReceipt, setPushReceipt] = useState<FeishuPushReceipt | null>(
    null,
  );
  const [pullReceipt, setPullReceipt] = useState<FeishuPullReceipt | null>(
    null,
  );
  const [busy, setBusy] = useState<"push" | "pull" | "local" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const push = async () => {
    if (busy) return;
    setBusy("push");
    setError("");
    try {
      const next = await pushExperienceCandidateToFeishu(candidateId, {
        actor: "EXPERT_REVIEWER",
        expectedCandidateVersionId,
        requestId: newRequestId(),
      });
      setPushReceipt(next);
      await onSynced?.(next);
      setNotice("候选已同步为飞书审核投影；候选正文仍以本地版本为准。");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "同步飞书失败，候选本地状态未改变。",
      );
    } finally {
      setBusy(null);
    }
  };
  const pull = async () => {
    if (busy) return;
    setBusy("pull");
    setError("");
    try {
      const next = await pullFeishuExperienceReviews({
        actor: "EXPERT_REVIEWER",
        requestId: newRequestId(),
      });
      setPullReceipt(next);
      await onPulled?.(next);
      setNotice("已拉取飞书审核结果；服务端只处理审核决定、意见和审核人。");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "拉取飞书审核结果失败，本地审核不受影响。",
      );
    } finally {
      setBusy(null);
    }
  };
  const localReview = async () => {
    if (!onLocalReview || busy) return;
    setBusy("local");
    setError("");
    try {
      await onLocalReview();
      setNotice("本地审核操作已完成。飞书同步与本地审核彼此独立。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "本地审核操作失败。");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <p className={styles.live} aria-live="polite">
        {notice}
      </p>
      <header className={styles.header}>
        <div>
          <span>飞书审核投影</span>
          <h2 id={headingId}>同步与拉取审核结果</h2>
          <p>飞书只承接人工审核投影，不会反向覆盖候选正文。</p>
        </div>
      </header>
      <dl className={styles.syncFacts}>
        <div>
          <dt>同步状态</dt>
          <dd>
            {pushReceipt
              ? "已同步"
              : sync?.status === "SYNCED"
                ? "已同步"
                : sync?.status === "PENDING"
                  ? "等待同步"
                  : sync?.status === "FAILED"
                    ? "同步失败"
                    : "尚未同步"}
          </dd>
        </div>
        <div>
          <dt>提供方</dt>
          <dd>
            {pushReceipt?.provider === "FEISHU"
              ? "飞书"
              : pushReceipt?.provider === "DEMO_RULES"
                ? "DEMO_RULES"
                : sync?.status === "SYNCED"
                  ? "已保存同步记录（提供方以本次回执为准）"
                  : "待同步"}
          </dd>
        </div>
        <div>
          <dt>审核记录</dt>
          <dd>{pushReceipt?.recordId ?? sync?.recordId ?? "同步后显示"}</dd>
        </div>
      </dl>
      <details className={styles.details}>
        <summary>查看候选版本定位</summary>
        <p>候选 ID：{candidateId}</p>
        <p>候选版本 ID：{expectedCandidateVersionId}</p>
        {sync?.revision ? <p>已同步候选修订：第 {sync.revision} 版</p> : null}
        {sync?.syncedAt ? (
          <p>
            最近同步：
            {new Date(sync.syncedAt).toLocaleString("zh-CN", { hour12: false })}
          </p>
        ) : null}
      </details>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void push()}
        >
          {busy === "push" ? "正在同步…" : "同步到飞书审核"}
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void pull()}
        >
          {busy === "pull" ? "正在拉取…" : "拉取审核结果"}
        </button>
        {onLocalReview ? (
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void localReview()}
          >
            {busy === "local" ? "正在处理…" : "继续本地审核"}
          </button>
        ) : null}
      </div>
      {pullReceipt ? (
        <p className={styles.provider}>
          最近拉取：应用 {pullReceipt.summary.applied} 条，跳过{" "}
          {pullReceipt.summary.skipped} 条，失败 {pullReceipt.summary.failed}{" "}
          条。
        </p>
      ) : null}
    </section>
  );
}
