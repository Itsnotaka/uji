import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { buildUi } from "../src/tui.ts";
import { createTheme } from "../src/theme.ts";

void describe("composer frame", () => {
  let setup: TestRendererSetup;

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 64, height: 18 });
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("uses a continuous Grok-style rounded border", async () => {
    buildUi(setup.renderer, createTheme("light"));
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const contentRow = lines.findIndex((line) => line.includes("type a message…"));
    assert.ok(contentRow > 0, lines.join("\n"));
    assert.match(lines[contentRow - 1] ?? "", /^╭─+╮$/);
    assert.match(lines[contentRow] ?? "", /^│\s+> type a message….*│$/);
    assert.match(lines[contentRow + 1] ?? "", /^╰─+╯$/);
    assert.doesNotMatch(lines.slice(contentRow - 1, contentRow + 2).join(""), /[┄┅┈┉╌╍]/);
  });
});
