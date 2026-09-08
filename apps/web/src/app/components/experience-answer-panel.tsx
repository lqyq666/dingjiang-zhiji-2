"use client";

import { useState, type FormEvent } from "react";
import type { ExperienceAnswerResponse } from "@dingjiang/contracts";

import { answerExperience } from "../lib/vs17-api";
import styles from "./vs17-experience.module.css";

export type ExperienceAnswerFeedbackAction =
  "HELPFUL" | "CONTEXT_GAP" | "WRONG_SUGGESTION" | "MISSING_ANGLE" | "OTHER";

const feedbackLabel: Record<ExperienceAnswerFeedbackAction, string> = {
  HELPFUL: "有帮助",
  CONTEXT_GAP: "缺少上下文",
  WRONG_SUGGESTION: "建议不适用",
  MISSING_ANGLE: "遗漏角度",
  OTHER: "其他反馈",
};
const feedbackActions: ExperienceAnswerFeedbackAction[] = [
  "HELPFUL",
  "WRONG_SUGGESTION",
  "CONTEXT_GAP",
  "MISSING_ANGLE",
];
const newRequestId = () => crypto.randomUUID();

export function ExperienceAnswerPanel({
  projectId,
  onFeedback,
  feedbackUnavailableReason,
}: {
  projectId?: string;
  onFeedback?: (
    action: ExperienceAnswerFeedbackAction,
    response: ExperienceAnswerResponse,
  ) => Promise<void> | void;
  feedbackUnavailableReason?: string;
}) {
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<ExperienceAnswerResponse | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const ask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await answerExperience({
        actor: "PMC",
        question: text,
        ...(projectId ? { projectId } : {}),
        requestId: newRequestId(),
      });
      setResponse(next);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "经验问答暂时不可用，问题已保留。",
      );
    } finally {
      setBusy(false);
    }
  };
  const feedback = async (action: ExperienceAnswerFeedbackAction) => {
    if (!response || busy || !onFeedback) return;
    if (action !== "HELPFUL" && feedbackUnavailableReason) {
      setNotice(feedbackUnavailableReason);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onFeedback(action, response);
      setNotice("反馈已交给既有学习候选流程，不会改变项目或经验状态。");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "反馈登记失败，可再次尝试。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="experience-answer-title"
    >
      <p className={styles.live} aria-live="polite">
        {notice}
      </p>
      <header className={styles.header}>
        <div>
          <span>经验问答 · PROPOSAL</span>
          <h2 id="experience-answer-title">询问可参考的正式经验</h2>
          <p>回答不会替代当前项目事实或自动改变业务状态。</p>
        </div>
      </header>
      <form className={styles.questionForm} onSubmit={ask}>
        <label htmlFor="experience-answer-question">你的问题</label>
        <textarea
          id="experience-answer-question"
          value={question}
          maxLength={2000}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：该经验是否适用于当前产品和交期风险？"
          disabled={busy}
        />
        <button
          className={styles.primaryButton}
          type="submit"
          disabled={busy || !question.trim()}
        >
          {busy ? "正在查询…" : "获取 AI 建议"}
        </button>
      </form>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {response ? (
        <div className={styles.answer} aria-live="polite">
          <p className={styles.provider}>
            提供方：
            {response.run.provider === "DEMO_RULES"
              ? "DEMO_RULES 降级规则"
              : "Coze"}{" "}
            · 仅供参考
          </p>
          <p>{response.result.answer}</p>
          {response.result.matches.length ? (
            <ul className={styles.list}>
              {response.result.matches.map((match) => (
                <li key={match.experienceId}>
                  <strong>经验 {match.experienceId}</strong>
                  <span>
                    {match.applicability === "MATCH"
                      ? "适用"
                      : match.applicability === "PARTIAL_MATCH"
                        ? "部分适用"
                        : match.applicability === "NOT_APPLICABLE"
                          ? "不适用"
                          : "待澄清"}
                  </span>
                  <p>{match.reason}</p>
                  <details className={styles.details}>
                    <summary>查看证据引用（{match.citations.length}）</summary>
                    <ul>
                      {match.citations.map((citation) => (
                        <li
                          key={`${citation.sourceObjectId}-${citation.sourceVersionId}`}
                        >
                          <span>来源对象：{citation.sourceObjectId}</span>
                          <span>来源版本：{citation.sourceVersionId}</span>
                          <p>{citation.reference}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>
              未找到可安全引用的匹配经验。请补充产品、部门、场景或当前已核验事实。
            </p>
          )}
          {response.result.shouldClarify ||
          response.result.missingInformation.length ? (
            <section className={styles.missing}>
              <strong>
                {response.result.shouldClarify ? "需要澄清" : "仍缺少的信息"}
              </strong>
              <ul>
                {response.result.missingInformation.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {onFeedback ? (
            <>
              <div className={styles.feedback} aria-label="对本次 AI 建议反馈">
                {feedbackActions.map((action) => (
                  <button
                    type="button"
                    key={action}
                    disabled={busy}
                    onClick={() => void feedback(action)}
                  >
                    {feedbackLabel[action]}
                  </button>
                ))}
              </div>
              {feedbackUnavailableReason ? (
                <p className={styles.provider}>{feedbackUnavailableReason}</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
