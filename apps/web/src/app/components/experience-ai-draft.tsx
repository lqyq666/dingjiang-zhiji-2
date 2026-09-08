"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  experienceCandidateStructuredInputSchema,
  type ExperienceAiRun,
  type ExperienceCandidateStructuredInput,
  type ExperienceExtractionResult,
  type StructuredExperienceCard,
} from "@dingjiang/contracts";

import { generateExperienceAiDraft } from "../lib/vs17-api";
import styles from "./vs17-experience.module.css";

type DraftFields = Pick<
  ExperienceExtractionResult,
  | "title"
  | "applicableSituation"
  | "businessProblem"
  | "practice"
  | "resultSummary"
  | "limitations"
>;

const blankCard = (): StructuredExperienceCard => ({
  trigger: "",
  conditions: [],
  actions: [{ order: 1, action: "" }],
  rationale: "",
  exceptions: [],
  scope: { products: [], departments: [], scenarios: [] },
  claims: [],
  evidenceRefs: [],
  missingInformation: [],
});

const blankDraft = (): DraftFields => ({
  title: "",
  applicableSituation: "",
  businessProblem: "",
  practice: "",
  resultSummary: "",
  limitations: "",
});

const lines = (value: string) =>
  value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

const serializeActions = (card: StructuredExperienceCard) =>
  card.actions.map((item) => `${item.order}. ${item.action}`).join("\n");
const parseActions = (value: string) =>
  lines(value).map((item, index) => {
    const match = item.match(/^(\d+)\.\s*(.+)$/);
    return {
      order: match ? Number(match[1]) : index + 1,
      action: match?.[2] ?? item,
    };
  });
const serializeClaims = (card: StructuredExperienceCard) =>
  card.claims
    .map((item) => `${item.statement} | ${item.evidenceIds.join(", ")}`)
    .join("\n");
const parseClaims = (value: string) =>
  lines(value).map((item) => {
    const [statement = "", ids = ""] = item.split("|", 2);
    return {
      statement: statement.trim(),
      evidenceIds: ids
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    };
  });
const serializeRefs = (card: StructuredExperienceCard) =>
  card.evidenceRefs
    .map(
      (item) =>
        `${item.sourceObjectId} | ${item.sourceVersionId} | ${item.reference}`,
    )
    .join("\n");
const parseRefs = (value: string) =>
  lines(value).map((item) => {
    const [sourceObjectId = "", sourceVersionId = "", reference = ""] =
      item.split("|", 3);
    return {
      sourceObjectId: sourceObjectId.trim(),
      sourceVersionId: sourceVersionId.trim(),
      reference: reference.trim(),
    };
  });

const newRequestId = () => crypto.randomUUID();

export const createExperienceDraftSingleFlight = () => {
  let active = false;
  return {
    tryStart: () => {
      if (active) return false;
      active = true;
      return true;
    },
    finish: () => {
      active = false;
    },
  };
};

export function ExperienceAiDraft({
  projectId,
  onSubmitCandidate,
  onDraftGenerated,
  initialDraft,
  initialStructuredCard,
}: {
  projectId: string;
  onSubmitCandidate: (
    input: ExperienceCandidateStructuredInput,
  ) => Promise<void> | void;
  onDraftGenerated?: (draft: ExperienceExtractionResult) => void;
  initialDraft?: DraftFields;
  initialStructuredCard?: StructuredExperienceCard | null;
}) {
  const [draft, setDraft] = useState<DraftFields>(initialDraft ?? blankDraft);
  const [card, setCard] = useState<StructuredExperienceCard>(
    initialStructuredCard ?? blankCard,
  );
  const [provider, setProvider] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<ExperienceAiRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submitGate = useRef(createExperienceDraftSingleFlight());

  const applyDraft = (next: ExperienceExtractionResult) => {
    setDraft({
      title: next.title,
      applicableSituation: next.applicableSituation,
      businessProblem: next.businessProblem,
      practice: next.practice,
      resultSummary: next.resultSummary,
      limitations: next.limitations,
    });
    setCard(next.structuredCard);
  };
  const updateField =
    (field: keyof DraftFields) =>
    (event: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));
  const updateCard = <K extends keyof StructuredExperienceCard>(
    key: K,
    value: StructuredExperienceCard[K],
  ) => setCard((current) => ({ ...current, [key]: value }));

  const generate = async () => {
    if (busy || submitting) return;
    setBusy(true);
    setError("");
    try {
      const response = await generateExperienceAiDraft(projectId, {
        actor: "PMC",
        requestId: newRequestId(),
      });
      applyDraft(response.draft);
      setProvider(response.run.provider);
      setRunDetails(response.run);
      onDraftGenerated?.(response.draft);
      setNotice("AI 已生成候选草稿。请核对并编辑后，再明确提交候选经验。");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "AI 草稿暂时不可用，请保留当前编辑后重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (busy || submitting || !submitGate.current.tryStart()) return;
    const parsed = experienceCandidateStructuredInputSchema.safeParse({
      actor: "PMC",
      ...draft,
      structuredCard: card,
    });
    if (!parsed.success) {
      setError("请补全六项经验字段、结构卡、证据定位与主张依据后再提交。");
      submitGate.current.finish();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmitCandidate(parsed.data);
      setNotice("候选经验已提交给既有流程；AI 草稿本身不会改变任何业务状态。");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "提交候选经验失败，当前编辑已保留。",
      );
    } finally {
      submitGate.current.finish();
      setSubmitting(false);
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="experience-ai-draft-title"
    >
      <p className={styles.live} aria-live="polite">
        {notice}
      </p>
      <header className={styles.header}>
        <div>
          <span>AI 候选建议 · PROPOSAL</span>
          <h2 id="experience-ai-draft-title">经验草稿与结构卡</h2>
          <p>AI 只提供可编辑候选；提交后才进入既有候选经验流程。</p>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={busy || submitting}
          onClick={() => void generate()}
        >
          {busy ? "正在生成…" : "生成 AI 草稿"}
        </button>
      </header>
      {provider ? (
        <p className={styles.provider}>
          提供方：{provider === "DEMO_RULES" ? "DEMO_RULES 降级规则" : "Coze"}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.formGrid}>
        <label>
          经验标题
          <input
            value={draft.title}
            maxLength={120}
            onChange={updateField("title")}
            disabled={busy || submitting}
          />
        </label>
        <label>
          适用情境
          <textarea
            value={draft.applicableSituation}
            maxLength={500}
            onChange={updateField("applicableSituation")}
            disabled={busy || submitting}
          />
        </label>
        <label>
          业务问题
          <textarea
            value={draft.businessProblem}
            maxLength={500}
            onChange={updateField("businessProblem")}
            disabled={busy || submitting}
          />
        </label>
        <label>
          实践做法
          <textarea
            value={draft.practice}
            maxLength={1000}
            onChange={updateField("practice")}
            disabled={busy || submitting}
          />
        </label>
        <label>
          结果摘要
          <textarea
            value={draft.resultSummary}
            maxLength={500}
            onChange={updateField("resultSummary")}
            disabled={busy || submitting}
          />
        </label>
        <label>
          限制条件
          <textarea
            value={draft.limitations}
            maxLength={500}
            onChange={updateField("limitations")}
            disabled={busy || submitting}
          />
        </label>
      </div>
      <section
        className={styles.subsection}
        aria-labelledby="experience-structured-card-title"
      >
        <header>
          <span>可编辑结构卡</span>
          <h3 id="experience-structured-card-title">适用边界与证据</h3>
        </header>
        <div className={styles.formGrid}>
          <label>
            触发信号
            <textarea
              value={card.trigger}
              maxLength={500}
              onChange={(event) => updateCard("trigger", event.target.value)}
              disabled={busy || submitting}
            />
          </label>
          <label>
            适用条件（每行一项）
            <textarea
              value={card.conditions.join("\n")}
              onChange={(event) =>
                updateCard("conditions", lines(event.target.value))
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            推荐动作（每行“序号. 动作”）
            <textarea
              value={serializeActions(card)}
              onChange={(event) =>
                updateCard("actions", parseActions(event.target.value))
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            理由
            <textarea
              value={card.rationale}
              maxLength={1000}
              onChange={(event) => updateCard("rationale", event.target.value)}
              disabled={busy || submitting}
            />
          </label>
          <label>
            例外情况（每行一项）
            <textarea
              value={card.exceptions.join("\n")}
              onChange={(event) =>
                updateCard("exceptions", lines(event.target.value))
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            产品范围（每行一项）
            <textarea
              value={card.scope.products.join("\n")}
              onChange={(event) =>
                updateCard("scope", {
                  ...card.scope,
                  products: lines(event.target.value),
                })
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            部门范围（每行一项）
            <textarea
              value={card.scope.departments.join("\n")}
              onChange={(event) =>
                updateCard("scope", {
                  ...card.scope,
                  departments: lines(event.target.value),
                })
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            场景范围（每行一项）
            <textarea
              value={card.scope.scenarios.join("\n")}
              onChange={(event) =>
                updateCard("scope", {
                  ...card.scope,
                  scenarios: lines(event.target.value),
                })
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            主张与证据 ID（每行“主张 | 证据ID, 证据ID”）
            <textarea
              value={serializeClaims(card)}
              onChange={(event) =>
                updateCard("claims", parseClaims(event.target.value))
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            证据定位（每行“来源对象ID | 来源版本ID | 引用说明”）
            <textarea
              value={serializeRefs(card)}
              onChange={(event) =>
                updateCard("evidenceRefs", parseRefs(event.target.value))
              }
              disabled={busy || submitting}
            />
          </label>
          <label>
            缺失信息（每行一项）
            <textarea
              value={card.missingInformation.join("\n")}
              onChange={(event) =>
                updateCard("missingInformation", lines(event.target.value))
              }
              disabled={busy || submitting}
            />
          </label>
        </div>
      </section>
      {runDetails ? (
        <details className={styles.details}>
          <summary>查看本次 AI 运行与证据定位</summary>
          <p>运行 ID：{runDetails.id}</p>
          <p>
            工作流：{runDetails.workflowId ?? "DEMO_RULES 未使用外部工作流"}
          </p>
          <p>执行 ID：{runDetails.executeId ?? "未提供"}</p>
          {runDetails.provider === "COZE" && runDetails.debugUrl ? (
            <p>
              <a href={runDetails.debugUrl} target="_blank" rel="noreferrer">
                打开 Coze 调试定位
              </a>
            </p>
          ) : null}
          <p>
            已将 AI
            输出填入上方可编辑结构卡；提交前请人工核对来源对象、版本与引用说明。
          </p>
        </details>
      ) : null}
      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={busy || submitting}
          onClick={() => void submit()}
        >
          {submitting ? "正在提交…" : "提交候选经验"}
        </button>
        <small>这是真正进入候选流程的唯一操作。</small>
      </div>
    </section>
  );
}
