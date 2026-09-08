"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type {
  TaskAssistantRequest,
  TaskAssistantResponse,
} from "@dingjiang/contracts";

import { assistTask } from "../lib/vs01-api";
import { taskAssistantCoverageSummary } from "../lib/task-assistant-copy";
import ui from "./vs01-workspace.module.css";

type Message = { role: "user" | "assistant"; text: string };

export function TaskCopilot({
  taskId,
  refreshKey = 0,
  docked = false,
  onRequestCollapse,
}: {
  taskId: string;
  refreshKey?: number;
  docked?: boolean;
  onRequestCollapse?: () => void;
}) {
  const [open, setOpen] = useState(docked);
  const [response, setResponse] = useState<TaskAssistantResponse | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setResponse(null);
    setError("");
    setMessages([
      {
        role: "assistant",
        text: "可以询问当前订单的事实、材料与下一步。建议需要你核对后再保存判断。",
      },
    ]);
  }, [refreshKey, taskId]);

  const ask = async (intent: TaskAssistantRequest["intent"], text: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    if (text) setMessages((current) => [...current, { role: "user", text }]);
    try {
      const next = await assistTask(taskId, {
        actor: "PMC",
        intent,
        question: text,
      });
      setResponse(next);
      setMessages((current) => [
        ...current,
        { role: "assistant", text: next.answer },
      ]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "AI 工作助手暂时不可用",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    void ask("ASK", text);
  };

  if (!open && !docked)
    return (
      <button
        className={ui.copilotLauncher}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="打开诊断 AI 工作助手"
      >
        <span aria-hidden="true">AI</span>
        <strong>诊断助手</strong>
        {response ? (
          <small>{response.context.coverage.evidenceCount} 条证据</small>
        ) : null}
      </button>
    );

  return (
    <section
      className={`${ui.copilotPanel} ${docked ? ui.copilotPanelDocked : ""}`}
      aria-label="诊断 AI 工作助手"
      aria-live="polite"
    >
      <header className={ui.copilotHeader}>
        <div>
          <strong>诊断 AI 工作助手</strong>
          <small>读取当前订单诊断 · 只给建议，不自动写入判断</small>
        </div>
        <button
          type="button"
          onClick={() => (docked ? onRequestCollapse?.() : setOpen(false))}
          aria-label="收起诊断 AI 工作助手"
          title="收起诊断 AI 工作助手"
        >
          {docked ? "›" : "×"}
        </button>
      </header>
      {response ? (
        <div className={ui.copilotCoverage}>
          <strong>
            {response.context.workTitle} · {response.context.order.orderId}
          </strong>
          <span>{taskAssistantCoverageSummary(response.context.coverage)}</span>
          <span>
            有效正式经验候选参考：
            {response.context.coverage.experienceReferenceCount} 条
          </span>
          {response.context.experienceReferences.filter(
            (reference) => reference.status === "ACTIVE",
          ).length ? (
            <ul className={ui.copilotReferences}>
              {response.context.experienceReferences
                .filter((reference) => reference.status === "ACTIVE")
                .map((reference) => (
                  <li key={reference.id}>
                    {reference.title} · 候选参考，非当前事实
                  </li>
                ))}
            </ul>
          ) : (
            <span>暂无有效正式经验候选参考。</span>
          )}
          <span>当前建议：{response.context.nextAction}</span>
          {response.context.materialGaps.length ? (
            <div className={ui.copilotMaterialGaps}>
              <strong>需要补充的材料</strong>
              <ul>
                {response.context.materialGaps.map((gap) => (
                  <li key={`${gap.situation}-${gap.requirement}`}>
                    <span>{gap.requirement}</span>
                    {gap.requirementId ? (
                      <Link
                        href={`/employee/task/${encodeURIComponent(taskId)}?${new URLSearchParams({ requirementId: gap.requirementId, material: gap.requirement }).toString()}#materials`}
                      >
                        去补充材料
                      </Link>
                    ) : (
                      <small>请在中央工作区核对对应需求</small>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={ui.copilotMessages}>
        {messages.slice(-6).map((message, index) => (
          <p key={`${message.role}-${index}`} data-role={message.role}>
            {message.text}
          </p>
        ))}
        {busy ? <p data-role="assistant">正在结合当前诊断上下文检查…</p> : null}
      </div>
      {error ? (
        <p className={ui.copilotError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={ui.copilotQuick} aria-label="诊断助手常用问题">
        <button
          type="button"
          disabled={busy}
          onClick={() => void ask("NEXT_ACTION", "")}
        >
          下一步做什么
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void ask("MATERIAL_GAPS", "")}
        >
          还缺什么材料
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void ask("RISK", "")}
        >
          检查推进风险
        </button>
      </div>
      <form className={ui.copilotPrompt} onSubmit={submit}>
        <label className={ui.srOnly} htmlFor="task-copilot-question">
          询问当前订单诊断
        </label>
        <input
          id="task-copilot-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={500}
          placeholder="问证据、材料缺口、风险或下一步…"
        />
        <button type="submit" disabled={busy || !question.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}
