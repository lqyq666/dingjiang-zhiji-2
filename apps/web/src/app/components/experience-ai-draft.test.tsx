import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createExperienceDraftSingleFlight,
  ExperienceAiDraft,
} from "./experience-ai-draft";

describe("ExperienceAiDraft", () => {
  it("renders an explicit PROPOSAL, one generation entry, and one final submission action", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperienceAiDraft, {
        projectId: "PRJ-OTD-001",
        onSubmitCandidate: vi.fn(),
      }),
    );

    expect(markup).toContain("AI 候选建议 · PROPOSAL");
    expect(markup).toContain("生成 AI 草稿");
    expect(markup).toContain("提交候选经验");
    expect(markup).toContain("这是真正进入候选流程的唯一操作。");
    expect(markup.match(/<button/g) ?? []).toHaveLength(2);
    expect(markup.match(/提交候选经验/g) ?? []).toHaveLength(1);
  });

  it("blocks concurrent submissions and accepts a new submission after finish", () => {
    const gate = createExperienceDraftSingleFlight();

    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });
});
