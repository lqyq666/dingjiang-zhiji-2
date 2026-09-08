"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  AssistantFeedbackInput,
  AssistantFeedbackReceipt,
  ExperienceCandidateDraft,
  ProjectAssistantRequest,
  ProjectAssistantResponse,
} from "@dingjiang/contracts";

import {
  appendProjectStageMessage,
  canCreateAnalysisPlan,
  getProjectStageView,
  setStageClarificationAnswer,
  type ProjectStageAnalysisSessions,
  type ProjectStageCode,
  type ProjectStageThreadKey,
  type ProjectStageThreads,
} from "../lib/project-stage-copilot";
import {
  assistProject,
  createAssistantFeedback,
  getAssistantFeedback,
  withdrawAssistantFeedback,
} from "../lib/vs01-api";
import {
  createAssistantRuntimeRun,
  getAssistantRuntimeHistory,
  readAssistantRuntimeStream,
} from "../lib/assistant-runtime-api";
import {
  createAssistantStreamState,
  reduceAssistantStreamEvent,
  restoreAssistantStreamHistory,
  type AssistantUiStatus,
} from "../lib/assistant-stream";
import ui from "./vs01-workspace.module.css";

const stageStatusLabel = {
  LOCKED: "未解锁",
  READY: "待开始",
  IN_PROGRESS: "进行中",
  WAITING_REVIEW: "等待审批",
  COMPLETED: "已完成",
  RETURNED: "已退回",
} as const;
const workItemStatusLabel = {
  LOCKED: "未解锁",
  READY: "待执行",
  IN_PROGRESS: "处理中",
  WAITING_REVIEW: "等待处理",
  DONE: "员工已确认完成",
  RETURNED: "已退回",
} as const;
const materialStatusLabel = {
  AVAILABLE: "已具备",
  MISSING: "缺失",
  UNVERIFIED: "待核验",
} as const;
const outcomeStatusLabel = {
  NOT_MEASURED: "尚未确认",
  PENDING_ACCEPTANCE: "旧流程待重新确认",
  ACCEPTED: "员工已确认",
  RETURNED: "已重新打开",
} as const;
const candidateStatusLabel = {
  PENDING_REVIEW: "等待专家审核",
  RETURNED: "专家已退回",
  WITHDRAWN: "员工已撤回",
  APPROVED: "专家已批准",
} as const;
const feedbackIssueLabel = {
  CONTEXT_GAP: "上下文缺口",
  WRONG_SUGGESTION: "建议有误",
  MISSING_ANGLE: "遗漏分析角度",
  OTHER: "其他问题",
} as const;
const runtimeStatusLabel: Record<AssistantUiStatus, string> = {
  OBSERVING: "正在读取最新工作事实",
  THINKING: "正在分析，不会修改业务事实",
  SUGGESTING: "正在形成候选建议",
  CONVERSATION: "可继续追问当前节点",
};

type StageWorkflows = Partial<
  Record<ProjectStageCode, ProjectAssistantResponse["workflow"]>
>;
type StageFeedbackReceipts = Partial<
  Record<ProjectStageCode, AssistantFeedbackReceipt>
>;

export function ConsultantCopilot({
  projectId,
  refreshKey = 0,
  autoExperienceDraft = false,
  onExperienceDraft,
  docked = false,
  onRequestCollapse,
}: {
  projectId: string;
  refreshKey?: number;
  autoExperienceDraft?: boolean;
  onExperienceDraft?: (draft: ExperienceCandidateDraft) => void;
  docked?: boolean;
  onRequestCollapse?: () => void;
}) {
  const [open, setOpen] = useState(docked);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<ProjectAssistantResponse | null>(
    null,
  );
  const [selectedStageCode, setSelectedStageCode] =
    useState<ProjectStageCode | null>(null);
  const [stageThreads, setStageThreads] = useState<ProjectStageThreads>({});
  const [analysisSessions, setAnalysisSessions] =
    useState<ProjectStageAnalysisSessions>({});
  const [stageWorkflows, setStageWorkflows] = useState<StageWorkflows>({});
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackIssue, setFeedbackIssue] =
    useState<AssistantFeedbackInput["issueType"]>("CONTEXT_GAP");
  const [feedback, setFeedback] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [feedbackReceipts, setFeedbackReceipts] =
    useState<StageFeedbackReceipts>({});
  const [withdrawReason, setWithdrawReason] = useState("");
  const [runtime, setRuntime] = useState(createAssistantStreamState);
  const [runtimeError, setRuntimeError] = useState("");
  const appliedDraft = useRef(false);
  const draftHandler = useRef(onExperienceDraft);
  const conversationBody = useRef<HTMLDivElement>(null);
  const activeModeSection = useRef<HTMLElement>(null);
  const runtimeCursor = useRef<string | null>(null);
  const assistantRequestInFlight = useRef(false);

  useEffect(() => {
    draftHandler.current = onExperienceDraft;
  }, [onExperienceDraft]);

  useEffect(() => {
    appliedDraft.current = false;
    setSelectedStageCode(null);
    setStageThreads({});
    setAnalysisSessions({});
    setStageWorkflows({});
    setFeedbackReceipts({});
    setRuntime(createAssistantStreamState());
    setRuntimeError("");
    runtimeCursor.current = null;
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
    const applyStreamEvent = (
      event: Parameters<typeof reduceAssistantStreamEvent>[1],
    ) => {
      runtimeCursor.current = event.cursor;
      setRuntimeError("");
      setRuntime((current) => reduceAssistantStreamEvent(current, event));
    };
    const restoreAndStream = async () => {
      try {
        const history = await getAssistantRuntimeHistory(projectId);
        if (stopped) return;
        runtimeCursor.current = history.latestCursor;
        setRuntime((current) =>
          restoreAssistantStreamHistory(current, history),
        );
      } catch (reason) {
        if (!stopped && !controller.signal.aborted)
          setRuntimeError(
            reason instanceof Error
              ? reason.message
              : "无法恢复岗位助手历史；中间工作链仍可继续。",
          );
      }
      while (!stopped) {
        try {
          await readAssistantRuntimeStream({
            projectId,
            after: runtimeCursor.current,
            signal: controller.signal,
            onEvent: applyStreamEvent,
          });
          if (!stopped) await pause(500);
        } catch (reason) {
          if (stopped || controller.signal.aborted) return;
          setRuntimeError(
            reason instanceof Error
              ? reason.message
              : "实时岗位助手断开，正在按当前位置重连；中间工作链仍可继续。",
          );
          await pause(1_000);
        }
      }
    };
    void restoreAndStream();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setError("");
    void assistProject(projectId, {
      actor: "PMC",
      intent: autoExperienceDraft ? "EXPERIENCE_DRAFT" : "NEXT_ACTION",
      question: "",
      workflowAction: "INSPECT",
      clarificationAnswers: [],
      planConfirmed: false,
    })
      .then((next) => {
        if (!active) return;
        setResponse(next);
        setSelectedStageCode(
          (current) => current ?? next.context.currentStage.code,
        );
        setStageWorkflows((current) => ({
          ...current,
          [next.workflow.stageCode]: next.workflow,
        }));
        setStageThreads((current) => {
          const key = next.context.currentStage.code;
          return current[key]?.length
            ? current
            : { ...current, [key]: [{ role: "assistant", text: next.answer }] };
        });
        if (
          autoExperienceDraft &&
          next.experienceDraft &&
          draftHandler.current &&
          !appliedDraft.current
        ) {
          appliedDraft.current = true;
          draftHandler.current(next.experienceDraft);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "AI 工作助手暂时不可用",
          );
      });
    return () => {
      active = false;
    };
  }, [autoExperienceDraft, projectId, refreshKey]);

  useEffect(() => {
    let active = true;
    void getAssistantFeedback(projectId)
      .then((records) => {
        if (!active) return;
        setFeedbackReceipts(
          records.reduce<StageFeedbackReceipts>((latest, record) => {
            if (latest[record.stageCode]) return latest;
            return { ...latest, [record.stageCode]: record };
          }, {}),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId, refreshKey]);

  const ask = useCallback(
    async (
      intent: ProjectAssistantRequest["intent"],
      text: string,
      threadKey: ProjectStageThreadKey = "PROJECT",
    ) => {
      if (busy || assistantRequestInFlight.current) return;
      assistantRequestInFlight.current = true;
      setBusy(true);
      setError("");
      if (text)
        setStageThreads((current) =>
          appendProjectStageMessage(current, threadKey, {
            role: "user",
            text,
          }),
        );
      try {
        const next = await assistProject(projectId, {
          actor: "PMC",
          intent,
          question: text,
          workflowAction: "INSPECT",
          clarificationAnswers: [],
          planConfirmed: false,
          ...(threadKey === "PROJECT" ? {} : { stageCode: threadKey }),
        });
        setResponse(next);
        setStageWorkflows((current) => ({
          ...current,
          [next.workflow.stageCode]: next.workflow,
        }));
        setStageThreads((current) =>
          appendProjectStageMessage(current, threadKey, {
            role: "assistant",
            text: next.answer,
          }),
        );
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "AI 工作助手暂时不可用",
        );
      } finally {
        assistantRequestInFlight.current = false;
        setBusy(false);
      }
    },
    [busy, projectId],
  );

  useEffect(() => {
    const openForCurrentWork = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          question?: string;
          stageCode?: ProjectStageCode;
        }>
      ).detail;
      setOpen(true);
      const threadKey =
        detail?.stageCode ??
        selectedStageCode ??
        response?.context.currentStage.code ??
        "PROJECT";
      if (detail?.stageCode) setSelectedStageCode(detail.stageCode);
      if (detail?.question) void ask("ASK", detail.question, threadKey);
    };
    window.addEventListener("vs01:open-project-copilot", openForCurrentWork);
    return () =>
      window.removeEventListener(
        "vs01:open-project-copilot",
        openForCurrentWork,
      );
  }, [ask, response?.context.currentStage.code, selectedStageCode]);

  const activeStageCode =
    selectedStageCode ?? response?.context.currentStage.code ?? null;
  useEffect(() => {
    if (!selectedStageCode) return;
    const frame = requestAnimationFrame(() => {
      if (conversationBody.current) conversationBody.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedStageCode]);
  useEffect(() => {
    if (!analysisOpen && !feedbackOpen) return;
    const frame = requestAnimationFrame(() => {
      const body = conversationBody.current;
      const target = activeModeSection.current;
      if (!body || !target) return;
      body.scrollTop +=
        target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });
    return () => cancelAnimationFrame(frame);
  }, [analysisOpen, feedbackOpen]);
  const activeView =
    response && activeStageCode
      ? getProjectStageView(response.context, activeStageCode)
      : null;
  const activeStage = activeView?.stage ?? null;
  const activeWorkItems = activeView?.workItems ?? [];
  const activeActivities = activeView?.activities ?? [];
  const activeMaterialGaps =
    response && activeStage
      ? response.context.materialGaps.filter(
          (item) => item.stage === activeStage.name,
        )
      : [];
  const activeThreadKey: ProjectStageThreadKey = activeStageCode ?? "PROJECT";
  const messages = stageThreads[activeThreadKey] ?? [];
  const activeWorkflow = activeStageCode
    ? (stageWorkflows[activeStageCode] ?? null)
    : null;
  const activeAnswers = activeStageCode
    ? (analysisSessions[activeStageCode]?.answers ?? {})
    : {};
  const activeFeedbackReceipt = activeStageCode
    ? (feedbackReceipts[activeStageCode] ?? null)
    : null;
  const currentAssistantAnswer =
    [...messages].reverse().find((message) => message.role === "assistant")
      ?.text ??
    response?.answer ??
    "";

  const answerClarification = (questionId: string, answer: string) => {
    if (!activeStageCode) return;
    setAnalysisSessions((current) =>
      setStageClarificationAnswer(current, activeStageCode, questionId, answer),
    );
  };

  const runGuidedAnalysis = async (
    workflowAction: ProjectAssistantRequest["workflowAction"],
  ) => {
    if (!activeStageCode || busy || assistantRequestInFlight.current) return;
    assistantRequestInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await assistProject(projectId, {
        actor: "PMC",
        intent: "ASK",
        question: `请对“${activeStage?.name ?? "当前节点"}”执行${workflowAction === "PLAN" ? "分析计划" : workflowAction === "INSPECT" ? "澄清检查" : "候选分析与自检"}。`,
        stageCode: activeStageCode,
        workflowAction,
        clarificationAnswers: Object.entries(activeAnswers)
          .filter(([, answer]) => answer.trim())
          .map(([questionId, answer]) => ({ questionId, answer })),
        planConfirmed:
          workflowAction === "ANALYZE" || workflowAction === "VERIFY",
      });
      setResponse(next);
      setStageWorkflows((current) => ({
        ...current,
        [activeStageCode]: next.workflow,
      }));
      setStageThreads((current) =>
        appendProjectStageMessage(current, activeStageCode, {
          role: "assistant",
          text: next.answer,
        }),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "节点深度分析暂时不可用",
      );
    } finally {
      assistantRequestInFlight.current = false;
      setBusy(false);
    }
  };

  const submitAssistantFeedback = async () => {
    if (
      !activeStageCode ||
      !activeWorkflow ||
      busy ||
      assistantRequestInFlight.current
    )
      return;
    assistantRequestInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const receipt = await createAssistantFeedback(projectId, {
        actor: "PMC",
        stageCode: activeStageCode,
        contextFingerprint: activeWorkflow.contextFingerprint,
        issueType: feedbackIssue,
        assistantAnswer: currentAssistantAnswer,
        feedback,
        expectedBehavior,
      });
      setFeedbackReceipts((current) => ({
        ...current,
        [activeStageCode]: receipt,
      }));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "AI 学习候选登记失败",
      );
    } finally {
      assistantRequestInFlight.current = false;
      setBusy(false);
    }
  };

  const withdrawFeedback = async () => {
    if (
      !activeStageCode ||
      !activeFeedbackReceipt ||
      !withdrawReason.trim() ||
      busy ||
      assistantRequestInFlight.current
    )
      return;
    assistantRequestInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const receipt = await withdrawAssistantFeedback(
        projectId,
        activeFeedbackReceipt.id,
        { actor: "PMC", reason: withdrawReason },
      );
      setFeedbackReceipts((current) => ({
        ...current,
        [activeStageCode]: receipt,
      }));
      setWithdrawReason("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "AI 学习候选撤回失败",
      );
    } finally {
      assistantRequestInFlight.current = false;
      setBusy(false);
    }
  };

  const selectStage = (
    stage: ProjectAssistantResponse["context"]["stages"][number],
  ) => {
    setSelectedStageCode(stage.code);
    setAnalysisOpen(false);
    setFeedbackOpen(false);
    setFeedback("");
    setExpectedBehavior("");
    setWithdrawReason("");
    if (stageThreads[stage.code]?.length && stageWorkflows[stage.code]) return;
    if (busy) {
      setStageThreads((current) =>
        appendProjectStageMessage(current, stage.code, {
          role: "assistant",
          text: `已切换到“${stage.name}”。当前可先查看本节点事项与完成记录，上一条分析结束后可继续提问。`,
        }),
      );
      return;
    }
    void ask(
      "ASK",
      `请结合项目全部上下文，说明“${stage.name}”节点的完成情况、已完成事项、未完成事项、材料或证据缺口，以及下一步建议。`,
      stage.code,
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || assistantRequestInFlight.current) return;
    assistantRequestInFlight.current = true;
    setQuestion("");
    setRuntime((current) => ({
      ...current,
      status: "THINKING",
      notice: null,
      messages: [
        ...current.messages,
        {
          id: `user-${Date.now()}`,
          role: "user",
          text,
          evidenceIds: [],
        },
      ],
    }));
    setRuntimeError("");
    void createAssistantRuntimeRun(projectId, {
      intent: "ASK",
      question: text,
      ...(activeStageCode ? { stageCode: activeStageCode } : {}),
    })
      .catch((reason: unknown) => {
        setRuntimeError(
          reason instanceof Error
            ? reason.message
            : "实时岗位助手暂时不可用；中间工作链仍可继续。",
        );
        setRuntime((current) => ({ ...current, status: "OBSERVING" }));
      })
      .finally(() => {
        assistantRequestInFlight.current = false;
      });
  };

  if (!open && !docked)
    return (
      <button
        className={ui.copilotLauncher}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="打开 AI 工作助手"
      >
        <span aria-hidden="true">AI</span>
        <strong>工作助手</strong>
        {response ? (
          <small>{response.context.currentStage.progress}%</small>
        ) : null}
      </button>
    );

  return (
    <section
      className={`${ui.copilotPanel} ${docked ? ui.copilotPanelDocked : ""}`}
      aria-label="AI 工作助手"
      aria-live="polite"
    >
      <header className={ui.copilotHeader}>
        <div>
          <strong>AI 工作助手</strong>
          <small>
            {runtime.provider === "PI"
              ? "Pi Runtime · 只读上下文 · PROPOSAL"
              : runtime.provider === "DEMO_RULES"
                ? "DEMO_RULES 降级 · 只读上下文 · PROPOSAL"
                : "连接实时岗位助手中 · 只读上下文 · PROPOSAL"}
          </small>
        </div>
        <button
          type="button"
          onClick={() => (docked ? onRequestCollapse?.() : setOpen(false))}
          aria-label="收起 AI 工作助手"
          title="收起 AI 工作助手"
        >
          {docked ? "›" : "×"}
        </button>
      </header>
      {response ? (
        <div className={ui.copilotCoverage}>
          <strong>{response.context.workTitle}</strong>
          <span>
            已读取 {response.context.coverage.stageCount} 个步骤 ·{" "}
            {response.context.coverage.workItemCount} 项事项 ·{" "}
            {response.context.coverage.evidenceCount} 条证据 ·{" "}
            {response.context.coverage.activityCount} 条记录
          </span>
          <span>
            当前：{response.context.currentStage.name}{" "}
            {response.context.currentStage.completedItemCount}/
            {response.context.currentStage.totalItemCount}
          </span>
          <span>
            已引用 {response.context.coverage.experienceReferenceCount}{" "}
            条正式经验作为候选参考
          </span>
          <ol className={ui.copilotStages} aria-label="七步完整进度">
            {response.context.stages.map((stage, index) => (
              <li key={stage.code}>
                <button
                  type="button"
                  aria-pressed={stage.code === activeStageCode}
                  onClick={() => selectStage(stage)}
                >
                  <span>{index + 1}</span>
                  <strong>{stage.name}</strong>
                  <small>
                    {stage.completedItemCount}/{stage.totalItemCount} ·{" "}
                    {stageStatusLabel[stage.status]}
                  </small>
                </button>
              </li>
            ))}
          </ol>
          {response.context.experienceReferences.length ? (
            <ul className={ui.copilotReferences}>
              {response.context.experienceReferences
                .filter((reference) => reference.status === "ACTIVE")
                .map((reference) => (
                  <li key={reference.id}>
                    {reference.title} · 候选参考，非当前事实
                  </li>
                ))}
            </ul>
          ) : null}
          <details className={ui.copilotContextDetails}>
            <summary>查看 AI 已读取的全部工作上下文</summary>
            <section>
              <h3>全部事项</h3>
              <ul>
                {response.context.workItems.map((item) => (
                  <li key={item.id}>
                    <strong>
                      {item.stage} · {item.title}
                    </strong>
                    <span>
                      {item.owner === "OWNER" && item.status === "DONE"
                        ? "企业负责人已确认方案"
                        : workItemStatusLabel[item.status]}{" "}
                      · 输入缺口 {item.inputGapCount} 项
                    </span>
                    {item.progressNote ? (
                      <small>最近进展：{item.progressNote}</small>
                    ) : null}
                    {item.completionNote ? (
                      <small>完成说明：{item.completionNote}</small>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>材料与输入</h3>
              <ul>
                {response.context.materials.map((item, index) => (
                  <li
                    key={[
                      item.stage,
                      item.workItem,
                      item.input,
                      String(index),
                    ].join("-")}
                  >
                    <strong>
                      {item.workItem} · {item.input}
                    </strong>
                    <span>{materialStatusLabel[item.status]}</span>
                    {item.reference ? (
                      <small>来源：{item.reference}</small>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>经营结果与经验</h3>
              <p>
                OTD：{response.context.outcome.before}% →{" "}
                {response.context.outcome.current ?? "尚未确认"} / 目标{" "}
                {response.context.outcome.target}%
              </p>
              <p>
                结果：{outcomeStatusLabel[response.context.outcome.status]}
                ；候选经验：
                {response.context.experience.candidateStatus
                  ? candidateStatusLabel[
                      response.context.experience.candidateStatus
                    ]
                  : "尚未形成"}
                ； 正式经验：
                {response.context.experience.formalPublished
                  ? "已发布"
                  : "尚未发布"}
              </p>
            </section>
            <section>
              <h3>最近操作</h3>
              <ul>
                {response.context.recentActivities.map((activity, index) => (
                  <li
                    key={[
                      activity.createdAt,
                      activity.eventType,
                      String(index),
                    ].join("-")}
                  >
                    <strong>
                      {activity.actor === "PMC"
                        ? "责任员工操作"
                        : activity.actor === "OWNER"
                          ? "企业负责人操作"
                          : "资深专家操作"}
                    </strong>
                    <span>{activity.note || "无补充说明"}</span>
                  </li>
                ))}
              </ul>
            </section>
          </details>
        </div>
      ) : null}
      <div className={ui.copilotConversationHeader}>
        <strong>
          {activeStage ? `${activeStage.name} · 节点对话` : "项目对话"}
        </strong>
        <small>{runtimeStatusLabel[runtime.status]}</small>
      </div>
      <div ref={conversationBody} className={ui.copilotMessages}>
        {activeStage ? (
          <section
            className={ui.copilotStageDetail}
            aria-label={`${activeStage.name}节点完成情况`}
          >
            <header>
              <div>
                <span>当前查看节点</span>
                <strong>{activeStage.name}</strong>
              </div>
              <b>{activeStage.progress}%</b>
            </header>
            <progress max={100} value={activeStage.progress}>
              {activeStage.progress}%
            </progress>
            {activeStageCode === "ROOT_CAUSE_VALIDATION" ? (
              <button
                className={ui.copilotWorkpaperAction}
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("vs16:open-root-cause-workpaper"),
                  )
                }
              >
                在中央打开核验底稿
              </button>
            ) : null}
            <ul>
              {activeWorkItems.map((item) => (
                <li key={item.id} data-status={item.status}>
                  <span aria-hidden="true">
                    {item.status === "DONE" ? "✓" : "·"}
                  </span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>
                      {item.owner === "OWNER" ? "企业负责人" : "企业绩效咨询师"}
                      ·{" "}
                      {item.owner === "OWNER" && item.status === "DONE"
                        ? "已确认方案"
                        : workItemStatusLabel[item.status]}
                    </small>
                    {item.completionNote ? (
                      <small>完成说明：{item.completionNote}</small>
                    ) : item.progressNote ? (
                      <small>最近进展：{item.progressNote}</small>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {activeMaterialGaps.length ? (
              <div className={ui.copilotMaterialGaps}>
                <strong>
                  AI 发现 {activeMaterialGaps.length} 项材料需要处理
                </strong>
                <ul>
                  {activeMaterialGaps.map((gap, index) => (
                    <li key={`${gap.workItem}-${gap.input}-${String(index)}`}>
                      <div>
                        <span>{gap.input}</span>
                        <small>{gap.workItem}</small>
                      </div>
                      <Link
                        href={`/employee/task/${encodeURIComponent(response!.context.sourceTaskId)}?${new URLSearchParams(
                          {
                            ...(gap.situationCode
                              ? { situation: gap.situationCode }
                              : {}),
                            material: gap.input,
                          },
                        ).toString()}#materials`}
                      >
                        {gap.status === "MISSING" ? "补充材料" : "核验材料"}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {activeActivities.length ? (
              <details>
                <summary>
                  查看本节点操作记录（{activeActivities.length}）
                </summary>
                <ul>
                  {activeActivities.slice(0, 6).map((activity, index) => (
                    <li
                      key={`${activity.createdAt}-${activity.eventType}-${index}`}
                    >
                      <span aria-hidden="true">·</span>
                      <div>
                        <strong>
                          {activity.actor === "PMC"
                            ? "责任员工"
                            : activity.actor === "OWNER"
                              ? "企业负责人"
                              : "资深专家"}
                        </strong>
                        <small>{activity.note || "无补充说明"}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}
        {analysisOpen && activeWorkflow ? (
          <section
            ref={activeModeSection}
            className={ui.copilotAnalysis}
            aria-label="节点深度分析"
          >
            <header>
              <div>
                <span>员工掌控的分析流程</span>
                <strong>{activeStage?.name}</strong>
              </div>
              <small>只分析，不推进任务</small>
            </header>
            <ol className={ui.copilotAnalysisSteps}>
              {["澄清", "计划", "分析", "自检"].map((label, index) => {
                const currentStep = {
                  CLARIFY: 0,
                  PLAN: 1,
                  ANALYSIS: 2,
                  VERIFICATION: 3,
                }[activeWorkflow.step];
                return (
                  <li
                    key={label}
                    data-state={
                      index < currentStep
                        ? "complete"
                        : index === currentStep
                          ? "current"
                          : "upcoming"
                    }
                  >
                    <span>{index + 1}</span>
                    {label}
                  </li>
                );
              })}
            </ol>

            {activeWorkflow.step === "CLARIFY" ? (
              <div className={ui.copilotClarifications}>
                <p>
                  AI
                  先把不明确的输入问清楚，避免直接给出看似完整、实际缺依据的建议。
                </p>
                {activeWorkflow.clarifications.map((item) => (
                  <label key={item.id}>
                    <span>
                      {item.question}
                      {item.required ? <b>必答</b> : <em>可选</em>}
                    </span>
                    <small>{item.reason}</small>
                    <textarea
                      rows={2}
                      maxLength={500}
                      value={activeAnswers[item.id] ?? ""}
                      onChange={(event) =>
                        answerClarification(item.id, event.target.value)
                      }
                      placeholder="输入现场情况、可信版本或希望 AI 重点检查的范围"
                    />
                  </label>
                ))}
                <button
                  type="button"
                  disabled={
                    busy ||
                    !canCreateAnalysisPlan(
                      activeWorkflow.clarifications,
                      activeAnswers,
                    )
                  }
                  onClick={() => void runGuidedAnalysis("PLAN")}
                >
                  生成可检查的分析计划
                </button>
              </div>
            ) : null}

            {activeWorkflow.step === "PLAN" ? (
              <div className={ui.copilotPlan}>
                <p>先核对计划。前三项可同时分析，综合建议要等它们全部完成。</p>
                <ol>
                  {activeWorkflow.plan.map((unit) => (
                    <li key={unit.id}>
                      <header>
                        <strong>{unit.title}</strong>
                        <span>
                          {unit.executionMode === "PARALLEL"
                            ? "可并行"
                            : "顺序汇总"}
                        </span>
                      </header>
                      <p>{unit.objective}</p>
                      <dl>
                        <div>
                          <dt>输入</dt>
                          <dd>{unit.inputs.join("、")}</dd>
                        </div>
                        <div>
                          <dt>输出</dt>
                          <dd>{unit.output}</dd>
                        </div>
                        <div>
                          <dt>依赖</dt>
                          <dd>
                            {unit.dependsOn.length
                              ? unit.dependsOn
                                  .map(
                                    (dependency) =>
                                      activeWorkflow.plan.find(
                                        (candidate) =>
                                          candidate.id === dependency,
                                      )?.title ?? dependency,
                                  )
                                  .join("、")
                              : "无，可直接开始"}
                          </dd>
                        </div>
                        <div>
                          <dt>完成检查</dt>
                          <dd>{unit.completionCheck}</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ol>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runGuidedAnalysis("ANALYZE")}
                >
                  开始分析
                </button>
                <small>
                  只启动本次 AI 分析，不会完成事项、推进步骤或触发审批。
                </small>
              </div>
            ) : null}

            {activeWorkflow.step === "VERIFICATION" ? (
              <div className={ui.copilotAnalysisResult}>
                <h3>候选分析结果</h3>
                <ul>
                  {activeWorkflow.plan.map((unit) => (
                    <li key={unit.id}>
                      <strong>{unit.title}</strong>
                      <p>{unit.finding}</p>
                    </li>
                  ))}
                </ul>
                <h3>AI 自检</h3>
                <ul>
                  {activeWorkflow.verification.map((check) => (
                    <li key={check.id} data-status={check.status}>
                      <span aria-hidden="true">
                        {check.status === "PASS" ? "✓" : "!"}
                      </span>
                      <div>
                        <strong>{check.label}</strong>
                        <small>{check.detail}</small>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className={ui.copilotTruthBoundary}>
                  AI
                  自检通过不等于业务事项完成。员工仍要在中央工作区核对输出和验收标准后亲自确认。
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runGuidedAnalysis("INSPECT")}
                >
                  重新澄清并分析
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {feedbackOpen && activeWorkflow ? (
          <section
            ref={activeModeSection}
            className={ui.copilotFeedback}
            aria-label="教 AI 学习候选"
          >
            <header>
              <div>
                <span>教 AI</span>
                <strong>登记可评审的改进候选</strong>
              </div>
              <small>不会自动修改线上规则</small>
            </header>
            {activeFeedbackReceipt ? (
              <div className={ui.copilotFeedbackReceipt}>
                <strong>
                  {activeFeedbackReceipt.status === "PENDING_REVIEW"
                    ? "已进入人工评审队列"
                    : "这条学习候选已撤回"}
                </strong>
                <p>
                  {activeFeedbackReceipt.status === "PENDING_REVIEW"
                    ? "反馈已与当前节点和上下文快照绑定；通过评测与人工批准前不会改变 AI。"
                    : activeFeedbackReceipt.withdrawnReason}
                </p>
                {activeFeedbackReceipt.status === "PENDING_REVIEW" ? (
                  <div>
                    <label>
                      撤回原因
                      <input
                        value={withdrawReason}
                        maxLength={500}
                        onChange={(event) =>
                          setWithdrawReason(event.target.value)
                        }
                        placeholder="例如：选错回答，准备重新登记"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || withdrawReason.trim().length < 5}
                      onClick={() => void withdrawFeedback()}
                    >
                      撤回误提交
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setFeedbackReceipts((current) => {
                        const next = { ...current };
                        delete next[activeStageCode!];
                        return next;
                      });
                      setFeedback("");
                      setExpectedBehavior("");
                    }}
                  >
                    重新登记改进候选
                  </button>
                )}
              </div>
            ) : (
              <div className={ui.copilotFeedbackForm}>
                <label>
                  问题类型
                  <select
                    value={feedbackIssue}
                    onChange={(event) =>
                      setFeedbackIssue(
                        event.target
                          .value as AssistantFeedbackInput["issueType"],
                      )
                    }
                  >
                    {Object.entries(feedbackIssueLabel).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  这次回答哪里需要改进
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    placeholder="指出漏读的材料、错误建议或缺少的分析角度"
                  />
                </label>
                <label>
                  你期望 AI 下次怎么做
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={expectedBehavior}
                    onChange={(event) =>
                      setExpectedBehavior(event.target.value)
                    }
                    placeholder="写出可验证的正确行为"
                  />
                </label>
                <button
                  type="button"
                  disabled={
                    busy ||
                    feedback.trim().length < 5 ||
                    expectedBehavior.trim().length < 5 ||
                    !currentAssistantAnswer
                  }
                  onClick={() => void submitAssistantFeedback()}
                >
                  登记为学习候选
                </button>
              </div>
            )}
          </section>
        ) : null}
        {messages.slice(-6).map((message, index) => (
          <p key={`${message.role}-${index}`} data-role={message.role}>
            {message.text}
          </p>
        ))}
        {runtime.messages.slice(-8).map((message) => (
          <div
            key={message.id}
            className={ui.copilotRuntimeMessage}
            data-role={message.role}
          >
            <p>{message.text}</p>
            {message.role === "assistant" ? (
              <small>
                {message.provider === "PI"
                  ? "Pi Runtime 候选建议"
                  : message.provider === "DEMO_RULES"
                    ? "DEMO_RULES 降级建议"
                    : "正在生成候选建议"}
                {message.evidenceIds.length
                  ? ` · 依据：${message.evidenceIds.join("、")}`
                  : ""}
              </small>
            ) : null}
            {message.role === "assistant" &&
            message.evidenceIds.length &&
            response ? (
              <Link
                href={`/employee/task/${encodeURIComponent(response.context.sourceTaskId)}#materials`}
              >
                查看引用证据
              </Link>
            ) : null}
          </div>
        ))}
        {runtime.activeTool ? (
          <p className={ui.copilotRuntimeNotice}>
            正在只读调用：{runtime.activeTool}
          </p>
        ) : null}
        {runtime.notice ? (
          <p className={ui.copilotRuntimeNotice}>{runtime.notice}</p>
        ) : null}
        {busy ? <p data-role="assistant">正在结合全过程检查…</p> : null}
      </div>
      {response?.experienceDraft ? (
        <div className={ui.copilotDraft}>
          <span>候选经验草稿</span>
          <strong>{response.experienceDraft.title}</strong>
          <p>{response.experienceDraft.resultSummary}</p>
          {onExperienceDraft ? (
            <button
              type="button"
              onClick={() => onExperienceDraft(response.experienceDraft!)}
            >
              填入复核表单
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className={ui.copilotError} role="alert">
          {error}
        </p>
      ) : null}
      {runtimeError ? (
        <p className={ui.copilotError} role="alert">
          实时助手：{runtimeError}
        </p>
      ) : null}
      <div className={ui.copilotModeBar} aria-label="AI 节点工具">
        <span>节点工具</span>
        <button
          type="button"
          aria-pressed={analysisOpen}
          disabled={!activeStage || busy}
          onClick={() => {
            setAnalysisOpen((current) => !current);
            setFeedbackOpen(false);
          }}
        >
          深度分析
        </button>
        <button
          type="button"
          aria-pressed={feedbackOpen}
          disabled={!activeStage || !activeWorkflow || busy}
          onClick={() => {
            setFeedbackOpen((current) => !current);
            setAnalysisOpen(false);
          }}
        >
          教 AI
        </button>
      </div>
      <form className={ui.copilotPrompt} onSubmit={submit}>
        <label className={ui.srOnly} htmlFor="consultant-copilot-question">
          随时询问当前咨询任务
        </label>
        <input
          id="consultant-copilot-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={500}
          placeholder={
            activeStage
              ? `询问“${activeStage.name}”的进度、材料或风险…`
              : "问进度、材料、风险或下一步…"
          }
        />
        <button type="submit" disabled={!question.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}
