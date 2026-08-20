import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { powerlineStyled } from "../src/powerline.ts";
import { createTheme } from "../src/theme.ts";
import {
  AssistantBlock,
  appendAuthUrl,
  appendUser,
  authUrlText,
  createSyntaxStyle,
  DIFF_PREVIEW_LINES,
  renderItems,
  ToolCard,
} from "../src/transcript.ts";
import type { Transcript } from "../src/transcript.ts";

void describe("opentui frames", () => {
  const theme = createTheme("dark");
  let setup: TestRendererSetup;
  let transcript: Transcript;
  let scroll: ScrollBoxRenderable;

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 72, height: 30 });
    let counter = 0;
    scroll = new ScrollBoxRenderable(setup.renderer, {
      id: "scroll",
      width: "100%",
      height: 28,
      paddingRight: 1,
    });
    setup.renderer.root.add(scroll);
    transcript = {
      renderer: setup.renderer,
      container: scroll,
      syntaxStyle: createSyntaxStyle(theme),
      theme,
      nextId: (prefix = "n") => `${prefix}-${String(counter++)}`,
    };
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("powerline row reads left to right", async () => {
    const footer = new TextRenderable(setup.renderer, {
      id: "footer",
      content: powerlineStyled(
        {
          runState: "working",
          workspace: "june",
          branch: "main",
          dirty: true,
          provider: "openai",
          model: "gpt-5.6",
          effort: "low",
          session: "s_1234",
          queued: 1,
        },
        theme,
      ),
      height: 1,
    });
    setup.renderer.root.add(footer);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const row = frame.split("\n").find((line) => line.includes("working"));
    assert.ok(row !== undefined, frame);
    assert.match(row, / working │ june main\* │ openai\/gpt-5\.6 low │ s_1234 │ 1 queued/);
    assert.doesNotMatch(row, /[□]/);
    setup.renderer.root.remove(footer);
  });

  void test("tool card goes from running to done in one block", async () => {
    const card = new ToolCard(transcript, "bash", '{"command":"printf x"}');
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /⚒ \$ printf x/);
    card.update("partial");
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /⚒ \$ printf x …\s*\n┃ partial/);
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    card.complete(lines);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /✓ \$ printf x/);
    assert.match(frame, /… 4 more lines/);
    assert.doesNotMatch(frame, /partial/);
    assert.doesNotMatch(frame, /line 9/);
  });

  void test("edit results render a diff", async () => {
    const card = new ToolCard(transcript, "edit", '{"path":"a.ts","edits":[]}');
    card.complete("ok", {
      details: { diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line\n" },
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /✓ edit a\.ts/);
    assert.match(frame, /- old line/);
    assert.match(frame, /\+ new line/);
  });

  void test("large edit diffs state how many lines were omitted", async () => {
    const card = new ToolCard(transcript, "edit", '{"path":"large.ts","edits":[]}');
    const diff = [
      "--- a/large.ts",
      "+++ b/large.ts",
      ...Array.from({ length: DIFF_PREVIEW_LINES + 5 }, (_, index) => ` context ${String(index)}`),
    ].join("\n");
    card.complete("ok", { details: { diff } });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /… 7 more lines/);
  });

  void test("user and restored items reuse the same blocks", async () => {
    appendUser(transcript, "hello there");
    renderItems(transcript, [
      { kind: "assistant", text: "plain answer" },
      { kind: "tool", callId: "c", toolName: "read", args: '{"path":"b.ts"}', output: "body" },
    ]);
    const live = new AssistantBlock(transcript);
    live.append("streamed");
    live.finish();
    // Markdown parses off-thread and needs wall-clock time, not just render passes.
    let frame = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      if (frame.includes("plain answer") && frame.includes("streamed")) break;
    }
    assert.match(frame, /┃ you\s*\n┃ hello there/);
    assert.match(frame, /┃ june\s*\n┃ plain answer/);
    assert.match(frame, /┃ ✓ read b\.ts\s*\n┃ body/);
    assert.match(frame, /┃ june\s*\n┃ streamed/);
  });

  void test("auth URLs keep their complete visible text and link target", async () => {
    const url =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access";
    const styled = authUrlText(url, theme.user);
    assert.equal(styled.chunks.map((chunk) => chunk.text).join(""), url);
    assert.equal(styled.chunks[0]?.link?.url, url);

    appendAuthUrl(transcript, url);
    await setup.renderOnce();
    const visible = setup.captureCharFrame().replaceAll(/[\s█]/g, "");
    assert.equal(visible, url);
  });
});
