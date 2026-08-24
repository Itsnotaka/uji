import assert from "node:assert/strict";
import { test } from "node:test";
import { CliRenderEvents } from "@opentui/core";
import type { CliRendererErrorEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { AssistantMessage, Usage } from "@uji-ai/schema";
import { buildUi } from "../src/tui.ts";
import { THEME } from "../src/theme.ts";
import { appendUser, ConversationTurnBlock, ToolCard } from "../src/transcript.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const partialAssistant: AssistantMessage = {
  role: "assistant",
  content: [],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  usage,
  stopReason: "stop",
  timestamp: 0,
};

function editPatch(path: string, name: string): string {
  const additions = Array.from(
    { length: 30 },
    (_, index) => `+export const ${name}${String(index)} = ${String(index)};`,
  );
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1,31 @@",
    " export const existing = true;",
    ...additions,
    "",
  ].join("\n");
}

void test("a long thread keeps the full screen while streaming and when done", async () => {
  const setup = await createTestRenderer({
    width: 72,
    height: 65,
    openConsoleOnError: false,
  });
  const renderErrors: CliRendererErrorEvent[] = [];
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) =>
    renderErrors.push(event),
  );

  try {
    const ui = buildUi(setup.renderer, THEME);
    await setup.renderOnce();

    for (let index = 0; index < 40; index++) {
      appendUser(ui.transcript, `previous prompt ${String(index)}`);
    }
    const turn = new ConversationTurnBlock(ui.transcript);
    turn.addUser("current prompt");
    await setup.renderOnce();
    let reasoning = "";
    for (let index = 0; index < 49; index++) {
      const delta = `${index === 0 ? "" : "\n"}reasoning line ${String(index)}`;
      reasoning += delta;
      turn.updateAssistant({
        type: "thinking_delta",
        contentIndex: 0,
        delta,
        partial: partialAssistant,
      });
      if (index % 8 === 0) await setup.renderOnce();
    }

    const assertFullScreen = (frame: string): void => {
      assert.match(frame, /Plan, search, build anything/);
      assert.match(frame, /commands/);
      assert.equal(ui.root.height, setup.renderer.height);
      assert.equal(
        ui.scroll.height + ui.inputBox.height + ui.powerline.height + ui.hints.height,
        setup.renderer.height,
      );
      assert.ok(ui.scroll.viewport.height > 1);
      assert.equal(ui.inputBox.y, ui.scroll.height);
      assert.equal(ui.powerline.y, ui.inputBox.y + ui.inputBox.height);
      assert.equal(ui.hints.y, setup.renderer.height - ui.hints.height);
      assert.equal(
        ui.scroll.scrollTop,
        Math.max(0, ui.scroll.scrollHeight - ui.scroll.viewport.height),
      );
    };

    await setup.renderOnce();
    const streamingFrame = setup.captureCharFrame();
    assert.match(streamingFrame, /Thinking/);
    assert.match(streamingFrame, /… \d+ more lines/);
    assertFullScreen(streamingFrame);

    turn.updateAssistant({
      type: "thinking_end",
      contentIndex: 0,
      content: reasoning,
      partial: partialAssistant,
    });
    turn.settle();
    await setup.renderOnce();
    const completedFrame = setup.captureCharFrame();
    assert.match(completedFrame, /Thought/);
    assert.match(completedFrame, /Worked/);
    assert.doesNotMatch(completedFrame, /Thinking|… \d+ more lines/);
    assertFullScreen(completedFrame);
    assert.deepEqual(renderErrors, []);
  } finally {
    setup.renderer.destroy();
  }
});

void test("completed edits render inline when an earlier diff is clipped", async () => {
  const setup = await createTestRenderer({
    width: 92,
    height: 50,
    openConsoleOnError: false,
  });
  const renderErrors: CliRendererErrorEvent[] = [];
  setup.renderer.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) =>
    renderErrors.push(event),
  );

  try {
    const ui = buildUi(setup.renderer, THEME);
    const first = new ToolCard(ui.transcript, "edit", { path: "src/first.ts", edits: [] });
    const second = new ToolCard(ui.transcript, "edit", { path: "src/second.ts", edits: [] });
    await setup.renderOnce();

    first.complete("ok", { details: { patch: editPatch("src/first.ts", "first") } });
    second.complete("ok", { details: { patch: editPatch("src/second.ts", "second") } });

    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /✓ Edit src\/second\.ts/);
    assert.match(frame, /first29/);
    assert.match(frame, /second29/);
    assert.match(frame, /Plan, search, build anything/);
    assert.match(frame, /commands/);
    assert.ok(ui.scroll.scrollTop > 0);
    assert.equal(
      ui.scroll.scrollTop,
      Math.max(0, ui.scroll.scrollHeight - ui.scroll.viewport.height),
    );
    assert.deepEqual(renderErrors, []);
  } finally {
    setup.renderer.destroy();
  }
});
