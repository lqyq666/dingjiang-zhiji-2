import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./vs01-workspace.module.css", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("VS18 mobile workspace navigation stylesheet", () => {
  it("keeps the mobile trigger visible on narrow topbars and hidden by default on desktop", () => {
    expect(stylesheet).toContain(".mobileMenu,\n.scrim {\n  display: none;");
    expect(stylesheet).toContain(
      ".topbar .iconButton:not(.desktopPanelToggle):not(.mobileMenu),",
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 899px\)[\s\S]*?\.iconButton\.mobileMenu \{\s*display: grid;/,
    );
  });
});
