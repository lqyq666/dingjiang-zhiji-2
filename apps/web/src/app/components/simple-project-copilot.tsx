"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Project } from "@dingjiang/contracts";
import { assistProject } from "../lib/vs01-api";
import ui from "./vs01-workspace.module.css";

type PhaseCode = Project["phases"][number]["code"];
type Message = { role: "assistant" | "user"; text: string };

export function SimpleProjectCopilot({
  projectId,
  phaseCode,
  onRequestCollapse,
}: {
  projectId: string;
  phaseCode: PhaseCode;
  refreshKey?: number;
  onRequestCollapse?: () => void;
}) {
  const actionGate = useRef(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        text: "需要时问我事实、缺口或下一步。接受事项和提交成果，都在左侧事项内完成。",
      },
    ]);
  }, [phaseCode, projectId]);

  const submitQuestion = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || actionGate.current) return;
    actionGate.current = true;
    setQuestion("");
    setMessages((current) => [...current, { role: "user", text }]);
    setBusy(true);
    setError("");
    try {
      const response = await assistProject(projectId, {
        actor: "PMC",
        intent: "ASK",
        question: text,
        stageCode: phaseCode,
        workflowAction: "INSPECT",
        clarificationAnswers: [],
        planConfirmed: false,
      });
      setMessages((current) => [
        ...current,
        { role: "assistant", text: response.answer },
      ]);
    } catch (reason) {
      setQuestion((current) => current || text);
      setError(reason instanceof Error ? reason.message : "AI 对话暂时不可用");
    } finally {
      actionGate.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      className={`${ui.simpleCopilot} ${ui.copilotPanelDocked}`}
      aria-label="AI 工作助手"
    >
      <header className={ui.simpleCopilotHeader}>
        <div>
          <strong>AI 工作助手</strong>
          <small>只生成建议，不自动推进</small>
        </div>
        {onRequestCollapse ? (
          <button type="button" onClick={onRequestCollapse}>
            收起
          </button>
        ) : null}
      </header>
      <div className={ui.simpleCopilotBody}>
        <div className={ui.simpleMessages} aria-live="polite">
          {messages.slice(-8).map((message, index) => (
            <p key={`${message.role}-${index}`} data-role={message.role}>
              {message.text}
            </p>
          ))}
          {busy ? <p data-role="assistant">正在结合当前阶段检查…</p> : null}
        </div>
        <form className={ui.simplePrompt} onSubmit={submitQuestion}>
          <label className={ui.srOnly} htmlFor="simple-ai-question">
            询问当前阶段
          </label>
          <textarea
            id="simple-ai-question"
            rows={3}
            maxLength={500}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="问当前阶段的事实、风险或下一步…"
          />
          <button type="submit" disabled={busy || !question.trim()}>
            发送
          </button>
        </form>
      </div>
      {error ? (
        <p className={ui.copilotError} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
