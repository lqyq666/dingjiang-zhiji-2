import { describe, expect, it } from "vitest";

import {
  clampWorkspacePanel,
  defaultWorkspaceLayout,
  parseWorkspaceLayout,
  resizeWorkspacePanel,
} from "./workspace-layout";

describe("workspace layout", () => {
  it("clamps both resizable panels to usable bounds", () => {
    expect(clampWorkspacePanel("nav", 20)).toBe(184);
    expect(clampWorkspacePanel("nav", 900)).toBe(340);
    expect(clampWorkspacePanel("assistant", 20)).toBe(320);
    expect(clampWorkspacePanel("assistant", 900)).toBe(560);
  });

  it("uses opposite pointer directions for the two borders", () => {
    expect(resizeWorkspacePanel("nav", 236, 40)).toBe(276);
    expect(resizeWorkspacePanel("assistant", 380, 40)).toBe(340);
    expect(resizeWorkspacePanel("assistant", 380, -40)).toBe(420);
  });

  it("sanitizes saved browser state and falls back safely", () => {
    expect(parseWorkspaceLayout("not-json")).toEqual(defaultWorkspaceLayout);
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          navWidth: 999,
          assistantWidth: 1,
          navCollapsed: true,
          assistantCollapsed: false,
        }),
      ),
    ).toEqual({
      navWidth: 340,
      assistantWidth: 320,
      navCollapsed: true,
      assistantCollapsed: false,
    });
  });
});
