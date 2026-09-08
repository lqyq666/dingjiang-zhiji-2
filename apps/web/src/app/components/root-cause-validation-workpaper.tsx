"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ValidationWorkpaperContent,
  ValidationWorkpaperView,
} from "@dingjiang/contracts";

import { getTask } from "../lib/vs01-api";
import { completionConfirmation } from "../lib/employee-actions";
import { validationWorkpaperContentSchema } from "@dingjiang/contracts";
import {
  completeRootCauseWorkpaper,
  generateRootCauseCandidate,
  getRootCauseWorkpaper,
  reopenRootCauseWorkpaper,
  saveRootCauseWorkpaperDraft,
} from "../lib/vs16-api";
import {
  canConfirmWorkpaper,
  createWorkpaperSingleFlight,
  formatWorkpaperFactValue,
  workpaperErrorMessage,
} from "../lib/workpaper-ui";
import ui from "./vs01-workspace.module.css";

type ValidationConclusionResult =
  ValidationWorkpaperContent["conclusion"]["result"];

const resultLabel: Record<ValidationConclusionResult, string> = {
  SUPPORTS: "支持这个原因",
  DOES_NOT_SUPPORT: "不支持这个原因",
  INSUFFICIENT_INFORMATION: "信息不足，先补材料",
};
const assessmentLabel = {
  SUPPORTS: "支持",
  CONTRADICTS: "反驳",
  INCONCLUSIVE: "无定论",
} as const;

const newRequestId = () => crypto.randomUUID();

const initialContent = (
  view: ValidationWorkpaperView,
  candidateCause: string,
): ValidationWorkpaperContent => ({
  problemStatement: view.workItem.title,
  factFindings: view.context.facts.map((fact) => ({
    evidenceId: fact.evidenceId,
    assertion: `${fact.label}：${fact.value}`,
  })),
  materialFindings: view.context.materials.map((material) => ({
    materialId: material.materialId,
    assertion: material.contentPreview?.slice(0, 1000) || "",
    assessment: "INCONCLUSIVE",
    verificationStatus: "UNVERIFIED_INPUT",
    note: "",
  })),
  hypotheses: [candidateCause],
  conclusion: {
    result: "INSUFFICIENT_INFORMATION",
    statement: "",
    limitations: "",
    nextChecks: [],
  },
});

const contentFromView = (
  view: ValidationWorkpaperView,
  candidateCause: string,
) =>
  view.current?.content ??
  view.latestConfirmed?.content ??
  initialContent(view, candidateCause);

const formatTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });

function Locator({
  locator,
}: {
  locator: ValidationWorkpaperView["history"][number]["locator"];
}) {
  return (
    <details className={ui.traceDetails}>
      <summary>查看版本定位</summary>
      <dl>
        <div>
          <dt>引用</dt>
          <dd>{locator.reference}</dd>
        </div>
        <div>
          <dt>来源对象</dt>
          <dd>{locator.sourceObjectId}</dd>
        </div>
        <div>
          <dt>来源版本</dt>
          <dd>{locator.sourceVersionId}</dd>
        </div>
      </dl>
    </details>
  );
}

export function RootCauseValidationWorkpaper({
  projectId,
  sourceTaskId,
  onCompleted,
  onReopened,
}: {
  projectId: string;
  sourceTaskId: string;
  onCompleted: () => Promise<void> | void;
  onReopened: () => Promise<void> | void;
}) {
  const [view, setView] = useState<ValidationWorkpaperView | null>(null);
  const [content, setContent] = useState<ValidationWorkpaperContent | null>(
    null,
  );
  const [candidateCause, setCandidateCause] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mutation = useRef(createWorkpaperSingleFlight());

  const load = useCallback(async () => {
    setError("");
    try {
      const [next, task] = await Promise.all([
        getRootCauseWorkpaper(projectId),
        getTask(sourceTaskId),
      ]);
      setCandidateCause(task.analysis.candidateCause);
      setView(next);
      setContent(contentFromView(next, task.analysis.candidateCause));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载核验底稿。");
    }
  }, [projectId, sourceTaskId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("vs16:open-root-cause-workpaper", refresh);
    return () =>
      window.removeEventListener("vs16:open-root-cause-workpaper", refresh);
  }, [load]);

  const activeMaterials = useMemo(() => view?.context.materials ?? [], [view]);
  const isInsufficient =
    content?.conclusion.result === "INSUFFICIENT_INFORMATION";
  const completionReady =
    validationWorkpaperContentSchema.safeParse(content).success &&
    canConfirmWorkpaper({
      content: content!,
      completionNote: completionConfirmation,
      acceptedCount: view?.workItem.acceptanceCriteria.length ?? 0,
      requiredAcceptanceCount: view?.workItem.acceptanceCriteria.length ?? 0,
    });

  const run = async (
    action: () => Promise<ValidationWorkpaperView>,
    success: string,
    after?: (next: ValidationWorkpaperView) => Promise<void> | void,
  ) => {
    if (!mutation.current.tryStart()) return;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      setView(next);
      setContent(contentFromView(next, candidateCause));
      setNotice(success);
      await after?.(next);
    } catch (reason) {
      setError(workpaperErrorMessage(reason as Error & { code?: string }));
    } finally {
      mutation.current.finish();
      setBusy(false);
    }
  };

  if (!view || !content)
    return (
      <section
        className={`${ui.workpaper} ${ui.workpaperLoading}`}
        aria-busy="true"
      >
        <p>{error || "正在载入根因核验工作底稿…"}</p>
        {error ? (
          <button
            className={ui.secondaryButton}
            type="button"
            onClick={() => void load()}
          >
            重新加载
          </button>
        ) : null}
      </section>
    );

  const updateConclusion = <
    K extends keyof ValidationWorkpaperContent["conclusion"],
  >(
    key: K,
    value: ValidationWorkpaperContent["conclusion"][K],
  ) =>
    setContent((current) =>
      current
        ? { ...current, conclusion: { ...current.conclusion, [key]: value } }
        : current,
    );
  const updateMaterial = (
    materialId: string,
    patch: Partial<ValidationWorkpaperContent["materialFindings"][number]>,
  ) =>
    setContent((current) =>
      current
        ? {
            ...current,
            materialFindings: current.materialFindings.map((finding) =>
              finding.materialId === materialId
                ? { ...finding, ...patch }
                : finding,
            ),
          }
        : current,
    );

  return (
    <section className={ui.workpaper} aria-labelledby="task-workspace-title">
      <p className={ui.srOnly} aria-live="polite">
        {notice}
      </p>
      <header className={ui.workpaperHeader}>
        <div>
          <p className={ui.eyebrow}>确认原因</p>
          <h2 id="task-workspace-title">核对材料，写清结论</h2>
          <p>
            来源事实自动带入。只需判断材料是否支持原因，写明结论及适用边界。
          </p>
        </div>
        <span
          className={ui.status}
          data-tone={view.status === "CONFIRMED" ? "green" : "blue"}
        >
          {view.status === "CONFIRMED" ? "已确认" : "编辑中"}
        </span>
      </header>
      {error ? (
        <p className={ui.message} data-tone="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className={ui.workpaperSections}>
        <details className={ui.optionalFields}>
          <summary>
            查看已带入的来源事实（{view.context.facts.length} 项）
          </summary>
          <header>
            <span>
              已知事实 <small>FACT</small>
            </span>
            <h3 id="workpaper-facts">来源事实</h3>
          </header>
          <ul className={ui.workpaperList}>
            {view.context.facts.map((fact) => (
              <li key={fact.evidenceId}>
                <strong>{fact.label}</strong>
                <p>{formatWorkpaperFactValue(fact.value)}</p>
                <Locator locator={fact.locator} />
              </li>
            ))}
          </ul>
        </details>
        <section aria-labelledby="workpaper-proposal">
          <header>
            <span>待验证的原因</span>
            <h3 id="workpaper-proposal">要核实的原因是什么</h3>
          </header>
          <p className={ui.confirmationStatement}>
            {content.hypotheses.filter(Boolean).join("；") ||
              "请填写待验证的原因"}
          </p>
          <details
            className={ui.optionalFields}
            open={!content.hypotheses.some((item) => item.trim())}
          >
            <summary>调整候选原因</summary>
            <label className={ui.formField}>
              待验证原因（每行一项）
              <textarea
                value={content.hypotheses.join("\n")}
                maxLength={10000}
                onChange={(event) =>
                  setContent({
                    ...content,
                    hypotheses: event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean)
                      .slice(0, 20),
                  })
                }
                disabled={busy || view.status === "CONFIRMED"}
              />
            </label>
          </details>
          <div className={ui.workpaperActions}>
            <button
              className={ui.secondaryButton}
              type="button"
              disabled={
                busy || !activeMaterials.length || view.status === "CONFIRMED"
              }
              onClick={() =>
                void run(
                  () =>
                    generateRootCauseCandidate(projectId, {
                      actor: "PMC",
                      requestId: newRequestId(),
                      expectedRevision: view.revision,
                      materialIds: activeMaterials.map(
                        (item) => item.materialId,
                      ),
                    }),
                  "AI 候选已生成并填入编辑区；请自行核验后再确认。",
                )
              }
            >
              根据材料重新起草
            </button>
            <button
              className={ui.secondaryButton}
              type="button"
              disabled={
                busy ||
                view.status === "CONFIRMED" ||
                !validationWorkpaperContentSchema.safeParse(content).success
              }
              onClick={() =>
                void run(
                  () =>
                    saveRootCauseWorkpaperDraft(projectId, {
                      actor: "PMC",
                      requestId: newRequestId(),
                      expectedRevision: view.revision,
                      content,
                    }),
                  "草稿已保存；事项进度没有变化。",
                )
              }
            >
              保存草稿
            </button>
            <small>重新起草会替换当前编辑；生成内容仍需核对。</small>
          </div>
        </section>
        <section aria-labelledby="workpaper-materials">
          <header>
            <span>引用材料</span>
            <h3 id="workpaper-materials">材料核验</h3>
          </header>
          {activeMaterials.length ? (
            <ul className={ui.workpaperList}>
              {activeMaterials.map((material) => {
                const finding = content.materialFindings.find(
                  (item) => item.materialId === material.materialId,
                );
                if (!finding) return null;
                return (
                  <li key={material.materialId}>
                    <strong>{material.title}</strong>
                    <small>
                      {material.readableByAi
                        ? "已提取文件摘要"
                        : "请核对原文件"}
                    </small>
                    <details>
                      <summary>查看材料原文摘要</summary>
                      <p>
                        {material.contentPreview || "尚无摘要，请核对原文件。"}
                      </p>
                    </details>
                    <Locator locator={material.locator} />
                    <details
                      open={!finding.assertion.trim()}
                      className={ui.optionalFields}
                    >
                      <summary>核对或调整引用内容</summary>
                      <label className={ui.formField}>
                        引用内容
                        <textarea
                          value={finding.assertion}
                          maxLength={1000}
                          onChange={(event) =>
                            updateMaterial(material.materialId, {
                              assertion: event.target.value,
                            })
                          }
                          disabled={busy || view.status === "CONFIRMED"}
                        />
                      </label>
                    </details>
                    <label className={ui.formField}>
                      {material.title}：我已核对，其内容
                      <select
                        value={
                          finding.verificationStatus === "EMPLOYEE_CHECKED"
                            ? finding.assessment
                            : ""
                        }
                        onChange={(event) =>
                          updateMaterial(material.materialId, {
                            assessment: (event.target.value ||
                              "INCONCLUSIVE") as typeof finding.assessment,
                            verificationStatus: event.target.value
                              ? "EMPLOYEE_CHECKED"
                              : "UNVERIFIED_INPUT",
                          })
                        }
                        disabled={busy || view.status === "CONFIRMED"}
                      >
                        <option value="">尚未核对</option>
                        {Object.entries(assessmentLabel).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                    {finding.note ? <p>已有备注：{finding.note}</p> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className={ui.workpaperEmpty}>
              <p>尚无有效材料。材料补齐前不能确认完成。</p>
              <Link
                className={ui.primaryButton}
                href={`/employee/task/${sourceTaskId}#materials`}
              >
                去补充材料
              </Link>
            </div>
          )}
        </section>
        <section aria-labelledby="workpaper-conclusion">
          <header>
            <span>本次人工结论</span>
            <h3 id="workpaper-conclusion">员工结论</h3>
          </header>
          {view.status === "CONFIRMED" ? (
            <div className={ui.workpaperConfirmed}>
              <strong>
                {
                  resultLabel[
                    view.latestConfirmed?.content.conclusion.result ??
                      "SUPPORTS"
                  ]
                }
              </strong>
              <p>{view.latestConfirmed?.content.conclusion.statement}</p>
              {view.latestConfirmed ? (
                <>
                  <p>
                    确认于 {formatTime(view.latestConfirmed.createdAt)} · 版本{" "}
                    {view.latestConfirmed.revision}
                  </p>
                  <Locator locator={view.latestConfirmed.locator} />
                </>
              ) : null}
              <details className={ui.optionalFields}>
                <summary>需要更正结论</summary>
                <label className={ui.formField}>
                  重新打开原因
                  <textarea
                    value={reopenReason}
                    maxLength={500}
                    onChange={(event) => setReopenReason(event.target.value)}
                    placeholder="说明为什么要回到根因核验。"
                  />
                </label>
                <button
                  className={ui.secondaryButton}
                  type="button"
                  disabled={busy || !reopenReason.trim()}
                  onClick={() =>
                    void run(
                      () =>
                        reopenRootCauseWorkpaper(projectId, {
                          actor: "PMC",
                          requestId: newRequestId(),
                          expectedRevision: view.revision,
                          reason: reopenReason.trim(),
                        }),
                      "事项已重新打开；原确认版本会继续保留。",
                      onReopened,
                    )
                  }
                >
                  带原因重新打开事项
                </button>
              </details>
            </div>
          ) : (
            <>
              <fieldset className={ui.workpaperResult}>
                <legend>本次结论</legend>
                {(Object.keys(resultLabel) as ValidationConclusionResult[]).map(
                  (result) => (
                    <label key={result}>
                      <input
                        type="radio"
                        name="validation-result"
                        value={result}
                        checked={content.conclusion.result === result}
                        onChange={() => updateConclusion("result", result)}
                        disabled={busy}
                      />
                      {resultLabel[result]}
                    </label>
                  ),
                )}
              </fieldset>
              <label className={ui.formField}>
                结论说明
                <textarea
                  value={content.conclusion.statement}
                  maxLength={1000}
                  onChange={(event) =>
                    updateConclusion("statement", event.target.value)
                  }
                  disabled={busy}
                />
              </label>
              <label className={ui.formField}>
                限制与边界
                <textarea
                  value={content.conclusion.limitations}
                  maxLength={500}
                  onChange={(event) =>
                    updateConclusion("limitations", event.target.value)
                  }
                  disabled={busy}
                />
              </label>
              {isInsufficient ? (
                <div className={ui.workpaperEmpty}>
                  <strong>当前信息不足，不能确认完成。</strong>
                  <p>可先补充材料；如已完成核验，请选择实际结论。</p>
                  <Link
                    className={ui.primaryButton}
                    href={`/employee/task/${sourceTaskId}#materials`}
                  >
                    去补充材料
                  </Link>
                </div>
              ) : (
                <>
                  <div className={ui.completionCriteria}>
                    <strong>提交前请核对</strong>
                    <ul>
                      {view.workItem.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                    <p>{completionConfirmation}</p>
                  </div>
                  {!completionReady ? (
                    <p>
                      请补齐原因、结论和边界，并逐份判断引用材料；至少一份材料须支持或反驳原因。
                    </p>
                  ) : null}
                  <button
                    className={ui.primaryButton}
                    type="button"
                    disabled={busy || !completionReady}
                    onClick={() =>
                      void run(
                        () =>
                          completeRootCauseWorkpaper(projectId, {
                            actor: "PMC",
                            requestId: newRequestId(),
                            expectedRevision: view.revision,
                            content,
                            completionNote: completionConfirmation,
                            confirmedAcceptanceCriteria:
                              view.workItem.acceptanceCriteria,
                          }),
                        "结论已确认，事项已完成。正在进入定下方案。",
                        async () => {
                          await onCompleted();
                          document
                            .getElementById("task-workspace-title")
                            ?.scrollIntoView({
                              behavior: "smooth",
                              block: "center",
                            });
                        },
                      )
                    }
                  >
                    {busy ? "正在确认…" : "确认结论并完成事项"}
                  </button>
                </>
              )}
            </>
          )}
        </section>
      </div>
      {view.history.length ? (
        <details className={ui.workpaperHistory}>
          <summary>查看底稿版本历史（{view.history.length}）</summary>
          <ol>
            {view.history.map((version) => (
              <li key={`${version.kind}-${version.revision}`}>
                <strong>{version.kind}</strong>
                <span>
                  版本 {version.revision} · {formatTime(version.createdAt)}
                </span>
                <Locator locator={version.locator} />
                <details>
                  <summary>回看本版本正文</summary>
                  <p>
                    <strong>问题：</strong>
                    {version.content.problemStatement}
                  </p>
                  <p>
                    <strong>材料发现：</strong>
                    {version.content.materialFindings
                      .map(
                        (item) =>
                          `${item.assertion}（${assessmentLabel[item.assessment]}）`,
                      )
                      .join("；")}
                  </p>
                  <p>
                    <strong>待验证原因：</strong>
                    {version.content.hypotheses.join("；")}
                  </p>
                  <p>
                    <strong>结论：</strong>
                    {resultLabel[version.content.conclusion.result]} ·{" "}
                    {version.content.conclusion.statement}
                  </p>
                  <p>
                    <strong>限制：</strong>
                    {version.content.conclusion.limitations}
                  </p>
                </details>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
