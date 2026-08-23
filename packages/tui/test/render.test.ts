import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { CodeRenderable, ImageRenderable, rgbToHex, ScrollBoxRenderable } from "@opentui/core";
import type { Renderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import type { AssistantMessage, Usage } from "@uji-ai/schema";
import { fileAttachmentBlock } from "../src/composer.ts";
import { createChatKeymap, registerSelectionLayer } from "../src/keymap.ts";
import { GLYPHS, SPINNER_FRAMES } from "../src/constants.ts";
import { formatDuration } from "../src/format.ts";
import { THEME } from "../src/theme.ts";
import { displayWidth } from "../src/width.ts";
import {
  appendAuthUrl,
  appendUser,
  authUrlText,
  ConversationTurnBlock,
  createSubtleSyntaxStyle,
  createSyntaxStyle,
  renderItems,
  ToolCard,
} from "../src/transcript.ts";
import type { Transcript } from "../src/transcript.ts";

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

function renderables(root: Renderable): Renderable[] {
  return [root, ...root.getChildren().flatMap(renderables)];
}

function codeRenderables(root: Renderable): CodeRenderable[] {
  return renderables(root).filter(
    (renderable): renderable is CodeRenderable => renderable instanceof CodeRenderable,
  );
}

/** Await OpenTUI's documented highlight completion instead of polling frames. */
async function renderHighlightedFrame(setup: TestRendererSetup): Promise<string> {
  // The first layout gives nested CodeRenderables their actual width, which
  // can invalidate the constructor-time highlight pass.
  await setup.renderOnce();
  await Promise.all(codeRenderables(setup.renderer.root).map((code) => code.highlightingDone));
  await setup.renderOnce();
  return setup.captureCharFrame();
}

void describe("opentui frames", () => {
  const theme = THEME;
  const clock = new ManualClock();
  let setup: TestRendererSetup;
  let transcript: Transcript;
  let scroll: ScrollBoxRenderable;

  before(async () => {
    setup = await createTestRenderer({ width: 72, height: 30, clock });
  });

  beforeEach(() => {
    setup.resize(72, 30);
    for (const child of setup.renderer.root.getChildren()) child.destroyRecursively();
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
      subtleSyntaxStyle: createSubtleSyntaxStyle(theme),
      theme,
      nextId: (prefix = "n") => `${prefix}-${String(counter++)}`,
    };
  });

  after(() => {
    setup.renderer.destroy();
  });

  void test("tool card goes from running to done in one block", async () => {
    const card = new ToolCard(transcript, "bash", '{"command":"printf x"}');
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /● Run printf x/);
    card.update("partial");
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /● Run printf x  partial/);
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    card.complete(lines);
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /✓ Run printf x  12 lines/);
    assert.doesNotMatch(frame, /partial/);
  });

  void test("a capped result keeps its head and its tail", async () => {
    const card = new ToolCard(transcript, "bash", '{"command":"printf x"}');
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    card.complete(lines);
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /line 0/);
    assert.match(frame, /… 6 more lines/);
    assert.match(frame, /line 11/);
    assert.doesNotMatch(frame, /line 5/);
  });

  void test("tool output background fills a rectangular panel", async () => {
    const card = new ToolCard(transcript, "bash", '{"command":"printf x"}');
    card.complete("a longer output line\nshort");
    await setup.renderOnce();

    const outputs = ["a longer output line", "short"];
    const outputRows = setup
      .captureSpans()
      .lines.filter((line) =>
        outputs.some((output) => line.spans.some((span) => span.text === output)),
      );
    assert.equal(outputRows.length, 2);
    const backgroundWidths = outputRows.map((line) =>
      line.spans
        .filter((span) => rgbToHex(span.bg) === theme.codeBackground)
        .reduce((width, span) => width + span.width, 0),
    );
    assert.equal(backgroundWidths[0], backgroundWidths[1]);
    assert.ok((backgroundWidths[0] ?? 0) > "a longer output line".length);
  });

  void test("every chrome glyph is one column wide", () => {
    for (const glyph of Object.values(GLYPHS)) {
      assert.equal(Array.from(glyph).length, 1, glyph);
      assert.equal(displayWidth(glyph), 1, glyph);
    }
  });

  void test("one turn morphs working into a settled activity row", async () => {
    const turn = new ConversationTurnBlock(transcript);
    turn.addUser({ kind: "live", content: "hello" });
    await setup.renderOnce();
    const first = setup.captureCharFrame();
    assert.match(first, /Working/);
    assert.ok(SPINNER_FRAMES.some((frame) => first.includes(frame)));
    const activity = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Working"));
    assert.ok(activity !== undefined);
    assert.equal(rgbToHex(activity.fg), theme.dim);

    // A frame advances the spinner without touching the label.
    const elapsed = 80_000;
    clock.advance(elapsed);
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Working/);

    turn.settle();
    await setup.renderOnce();
    const settled = setup.captureCharFrame();
    assert.doesNotMatch(settled, /Working/);
    assert.ok(settled.includes(`Worked for ${formatDuration(elapsed)}`));
  });

  void test("reasoning, text, and tools stay above one persistent activity tail", async () => {
    const turn = new ConversationTurnBlock(transcript);
    turn.addUser({ kind: "live", content: "inspect this" });
    await setup.renderOnce();
    const root = scroll.getChildren()[0];
    const tail = root?.getChildren().at(-1);
    assert.ok(root !== undefined && tail !== undefined);

    turn.updateAssistant({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "checking",
      partial: partialAssistant,
    });
    await setup.renderOnce();
    const thinking = setup.captureCharFrame();
    assert.match(thinking, /Thinking/);
    assert.doesNotMatch(thinking, /Working/);
    assert.equal(root.getChildren().at(-1), tail);

    turn.updateAssistant({
      type: "thinking_end",
      contentIndex: 0,
      content: "checking",
      partial: partialAssistant,
    });
    turn.updateAssistant({
      type: "text_delta",
      contentIndex: 1,
      delta: "answer",
      partial: partialAssistant,
    });
    turn.startTool("call", "read", { path: "a.ts" });
    await setup.renderOnce();
    const active = setup.captureCharFrame();
    assert.match(active, /Thought[\s\S]*answer[\s\S]*● Read a\.ts[\s\S]*Working/);
    assert.equal(root.getChildren().at(-1), tail);

    turn.finishTool("call", "read", "file body");
    turn.settle();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /✓ Read a\.ts[\s\S]*Worked/);
    assert.equal(root.getChildren().at(-1), tail);
  });

  void test("thinking_end replaces the streamed preview instead of duplicating it", async () => {
    const turn = new ConversationTurnBlock(transcript);
    const sentence = "Planning to read builtins section";
    for (let index = 0; index < 3; index++) {
      turn.updateAssistant({
        type: "thinking_delta",
        contentIndex: 0,
        delta: sentence,
        partial: partialAssistant,
      });
    }
    turn.updateAssistant({
      type: "thinking_end",
      contentIndex: 0,
      content: sentence,
      partial: partialAssistant,
    });
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, new RegExp(sentence));
    const matches = frame.match(new RegExp(sentence, "g"));
    assert.equal(matches?.length, 1);
  });

  void test("a successful read has no empty result panel", async () => {
    const card = new ToolCard(transcript, "read", { path: "a.ts" });
    card.complete("first line\nsecond line");
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /✓ Read a\.ts  2 lines/);
    assert.doesNotMatch(frame, /first line|second line/);
    const codeBackground = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .some((span) => rgbToHex(span.bg) === theme.codeBackground);
    assert.equal(codeBackground, false);
  });

  void test("edit results render a diff", async () => {
    const card = new ToolCard(transcript, "edit", '{"path":"a.ts","edits":[]}');
    card.complete("ok", {
      details: {
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n unchanged\n",
      },
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /✓ Edit a\.ts/);
    assert.match(frame, /- old line/);
    assert.match(frame, /\+ new line/);

    const rows = setup.captureSpans().lines;
    const removedRow = rows.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("old line"),
    );
    const addedRow = rows.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("new line"),
    );
    const contextRow = rows.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes("unchanged"),
    );
    assert.ok(removedRow !== undefined);
    assert.ok(addedRow !== undefined);
    assert.ok(contextRow !== undefined);
    const coloredWidth = (row: (typeof rows)[number], color: string): number =>
      row.spans
        .filter((span) => rgbToHex(span.bg) === color)
        .reduce((width, span) => width + span.width, 0);
    const panelWidth = coloredWidth(contextRow, theme.codeBackground);
    assert.equal(coloredWidth(removedRow, theme.diffRemovedBackground), panelWidth);
    assert.equal(coloredWidth(addedRow, theme.diffAddedBackground), panelWidth);
  });

  void test("bash git diff output uses the rich diff renderer", async () => {
    const card = new ToolCard(transcript, "bash", '{"command":"git diff -- package.json"}');
    const patch = [
      "diff --git a/package.json b/package.json",
      "index 1111111..2222222 100644",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,8 +1,8 @@",
      ' {"line": 1}',
      ' {"line": 2}',
      ' {"line": 3}',
      ' {"line": 4}',
      '-{"old": true}',
      '+{"new": true}',
      ' {"line": 6}',
      ' {"line": 7}',
      ' {"line": 8}',
    ].join("\n");
    card.complete(`${patch}\n M package.json`);
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /✓ Run git diff -- package\.json  \+1 -1/);
    assert.match(frame, /"line": 4/);
    assert.match(frame, /- \{"old": true\}/);
    assert.match(frame, /\+ \{"new": true\}/);
    assert.match(frame, /M package\.json/);
    assert.doesNotMatch(frame, /Error parsing diff|more lines/);

    const rows = setup.captureSpans().lines;
    const removedRow = rows.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes('"old": true'),
    );
    const addedRow = rows.find((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .includes('"new": true'),
    );
    assert.ok(removedRow !== undefined);
    assert.ok(addedRow !== undefined);
    assert.ok(removedRow.spans.some((span) => rgbToHex(span.bg) === theme.diffRemovedBackground));
    assert.ok(addedRow.spans.some((span) => rgbToHex(span.bg) === theme.diffAddedBackground));
    const highlightedKey = addedRow.spans.find((span) => span.text === "new");
    assert.ok(highlightedKey !== undefined);
    assert.equal(rgbToHex(highlightedKey.fg), theme.type);
  });

  void test("a long diff reaches the renderer whole and is capped by its card", async () => {
    const card = new ToolCard(transcript, "edit", '{"path":"large.ts","edits":[]}');
    const added = Array.from({ length: 200 }, (_, index) => `+line ${String(index)}`);
    const diff = [
      "--- a/large.ts",
      "+++ b/large.ts",
      `@@ -1,1 +1,${String(added.length + 1)} @@`,
      " kept",
      ...added,
    ].join("\n");
    card.complete("ok", { details: { diff } });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // A truncated patch would fail to parse; the whole one renders its first lines.
    assert.doesNotMatch(frame, /Error parsing diff/);
    assert.match(frame, /line 0/);
  });

  void test("restored tool errors retain their error state", async () => {
    renderItems(transcript, [
      {
        kind: "turn",
        id: "turn-failed",
        entryIds: ["tool-result"],
        outcome: "completed",
        parts: [
          {
            kind: "tool",
            callId: "failed",
            toolName: "read",
            args: { path: "missing.ts" },
            output: "File not found",
            isError: true,
          },
        ],
      },
    ]);
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /✗ Read missing\.ts  File not found/);
  });

  void test("a suspended restored turn remains open for recovered tool output", async () => {
    const open = renderItems(
      transcript,
      [
        {
          kind: "turn",
          id: "suspended",
          entryIds: ["user", "assistant"],
          outcome: "completed",
          parts: [
            {
              kind: "user",
              entryId: "user",
              parentId: null,
              content: "read it",
            },
            {
              kind: "tool",
              callId: "call",
              toolName: "read",
              args: { path: "a.ts" },
            },
          ],
        },
      ],
      { openLastTurn: true },
    );
    assert.ok(open !== undefined);
    await setup.renderOnce();
    const suspended = setup.captureCharFrame();
    assert.match(suspended, /● Read a\.ts[\s\S]*Working/);
    assert.doesNotMatch(suspended, /Worked/);
    assert.equal(scroll.getChildren().length, 1);

    open.finishTool("call", "read", "file body");
    open.settle();
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /✓ Read a\.ts[\s\S]*Worked/);
    assert.equal(scroll.getChildren().length, 1);
  });

  void test("an open restored turn retains its failed outcome when later settled", async () => {
    const open = renderItems(
      transcript,
      [
        {
          kind: "turn",
          id: "failed",
          entryIds: ["assistant"],
          outcome: "failed",
          parts: [{ kind: "assistant", text: "partial answer" }],
        },
      ],
      { openLastTurn: true },
    );
    assert.ok(open !== undefined);
    open.settle();
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /partial answer[\s\S]*Failed/);
    assert.doesNotMatch(frame, /Worked/);
  });

  void test("user and restored items reuse the same blocks", async () => {
    appendUser(transcript, { kind: "live", content: "hello there" });
    renderItems(transcript, [
      {
        kind: "turn",
        id: "restored",
        entryIds: ["restored"],
        outcome: "completed",
        parts: [
          { kind: "assistant", text: "plain answer" },
          {
            kind: "tool",
            callId: "c",
            toolName: "read",
            args: '{"path":"b.ts"}',
            output: "body",
          },
        ],
      },
    ]);
    const live = new ConversationTurnBlock(transcript);
    live.updateAssistant({
      type: "text_delta",
      contentIndex: 0,
      delta: "streamed",
      partial: partialAssistant,
    });
    live.updateAssistant({
      type: "text_end",
      contentIndex: 0,
      content: "streamed",
      partial: partialAssistant,
    });
    live.settle();
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /❯ hello there/);
    assert.match(frame, /plain answer/);
    assert.match(frame, /✓ Read b\.ts  body/);
    assert.match(frame, /streamed/);
  });

  void test("user attachments render as clickable tags with an expandable image", async () => {
    let opened: string | undefined;
    let selected: string | undefined;
    transcript.openPath = (path) => {
      opened = path;
    };
    transcript.onUserMessage = (message) => {
      selected = message.entryId;
    };
    appendUser(transcript, {
      kind: "stored",
      message: {
        kind: "user",
        entryId: "e-user",
        parentId: null,
        content: [
          {
            type: "text",
            text: "review this @file:///tmp/screenshot.png [Image 1]",
          },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggWDxgWQ5q78wAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yMlQxNToyNDoyMiswMDowMCBNydkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjJUMTU6MjQ6MjIrMDA6MDBREHFlAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTIyVDE1OjI0OjIyKzAwOjAwBgVQugAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
          },
        ],
      },
    });
    await setup.renderOnce();
    const imagePreview = renderables(setup.renderer.root).find(
      (renderable): renderable is ImageRenderable => renderable instanceof ImageRenderable,
    );
    assert.ok(imagePreview !== undefined);
    await imagePreview.loadPromise;
    const before = setup.captureCharFrame();
    assert.match(before, /❯ review this/);
    assert.match(before, /File screenshot\.png/);
    assert.match(before, /Image 1/);
    assert.doesNotMatch(before, /@file:|iVBOR/);

    const lines = before.split("\n");
    const fileY = lines.findIndex((line) => line.includes("File screenshot.png"));
    const fileX = lines[fileY]?.indexOf("File screenshot.png") ?? -1;
    assert.ok(fileX >= 0 && fileY >= 0, before);
    await setup.mockMouse.click(fileX, fileY);
    assert.equal(opened, "/tmp/screenshot.png");

    const imageY = lines.findIndex((line) => line.includes("Image 1"));
    const imageX = lines[imageY]?.indexOf("Image 1") ?? -1;
    assert.ok(imageX >= 0 && imageY >= 0, before);
    await setup.mockMouse.click(imageX, imageY);
    await setup.renderOnce();
    assert.notEqual(setup.captureCharFrame(), before);

    const textY = lines.findIndex((line) => line.includes("review this"));
    const textX = lines[textY]?.indexOf("review this") ?? -1;
    assert.ok(textX >= 0 && textY >= 0, before);
    await setup.mockMouse.click(textX, textY);
    assert.equal(selected, "e-user");

    const widePreview = imagePreview.width;
    setup.resize(20, 30);
    await setup.renderOnce();
    assert.ok(imagePreview.width < widePreview);
    assert.ok(imagePreview.width <= setup.renderer.width);
  });

  void test("a pasted wall of text folds to a preview and a tag that opens it", async () => {
    const pasted = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join("\n");
    appendUser(transcript, { kind: "live", content: `look at this\n${pasted}` });
    await setup.renderOnce();
    const folded = setup.captureCharFrame();
    assert.match(folded, /❯ look at this/);
    assert.match(folded, /\+10 lines/);
    assert.doesNotMatch(folded, /line 12/);

    const lines = folded.split("\n");
    const y = lines.findIndex((line) => line.includes("+10 lines"));
    const x = lines[y]?.indexOf("+10 lines") ?? -1;
    assert.ok(x >= 0 && y >= 0, folded);

    await setup.mockMouse.click(x, y);
    await setup.renderOnce();
    const opened = setup.captureCharFrame();
    assert.match(opened, /line 12/);
    assert.match(opened, /fewer lines/);
  });

  void test("an attached file folds to a tag that opens its body in place", async () => {
    const body = Array.from(
      { length: 6 },
      (_, index) => `const x${String(index)} = ${String(index)};`,
    ).join("\n");
    appendUser(transcript, {
      kind: "live",
      content: `explain this ${fileAttachmentBlock("/tmp/sample.ts", body)}`,
    });
    await setup.renderOnce();

    // The body is the attachment, not the prompt: it must not leak into the turn.
    const folded = setup.captureCharFrame();
    assert.match(folded, /❯ explain this/);
    assert.match(folded, /File sample\.ts \+6 lines/);
    assert.doesNotMatch(folded, /const x0/);
    assert.doesNotMatch(folded, /<file src=/);

    const lines = folded.split("\n");
    const y = lines.findIndex((line) => line.includes("File sample.ts"));
    const x = lines[y]?.indexOf("File sample.ts") ?? -1;
    assert.ok(x >= 0 && y >= 0, folded);

    const background = (): string | undefined => {
      const span = setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((candidate) => candidate.text.includes("File sample.ts"));
      return span === undefined ? undefined : rgbToHex(span.bg);
    };
    assert.equal(background(), theme.pasteBackground);
    await setup.mockMouse.moveTo(x, y);
    await setup.renderOnce();
    assert.equal(background(), theme.hover, "tag should light up under the pointer");

    await setup.mockMouse.click(x, y);
    await setup.renderOnce();
    const opened = setup.captureCharFrame();
    assert.match(opened, /const x0/);
    assert.match(opened, /const x5/);
    // Once the body is on screen the line count stops being news.
    assert.doesNotMatch(opened, /\+6 lines/);

    await setup.mockMouse.click(x, y);
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /const x0/);
  });

  void test("a file with no inlined body still opens on click", async () => {
    let opened: string | undefined;
    transcript.openPath = (path) => {
      opened = path;
    };
    appendUser(transcript, { kind: "live", content: "look @file:///tmp/notes.txt" });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /File notes\.txt/);
    assert.doesNotMatch(frame, /\+\d+ lines/);

    const lines = frame.split("\n");
    const y = lines.findIndex((line) => line.includes("File notes.txt"));
    const x = lines[y]?.indexOf("File notes.txt") ?? -1;
    assert.ok(x >= 0 && y >= 0, frame);
    await setup.mockMouse.click(x, y);
    assert.equal(opened, "/tmp/notes.txt");
  });

  void test("holds an incomplete markdown prefix until its heading text arrives", async () => {
    const block = new ConversationTurnBlock(transcript);
    const append = (delta: string): void =>
      block.updateAssistant({
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: partialAssistant,
      });
    append("#");
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /#/);
    append("#");
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /##/);
    append("# ");
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /###/);
    append("Heading");
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /Heading/);
    assert.doesNotMatch(frame, /###/);
    block.updateAssistant({
      type: "text_end",
      contentIndex: 0,
      content: "### Heading",
      partial: partialAssistant,
    });
    block.settle();
    assert.match(await renderHighlightedFrame(setup), /Heading/);
  });

  void test("renders thinking markdown without exposing its markers", async () => {
    const block = new ConversationTurnBlock(transcript);
    block.updateAssistant({
      type: "thinking_end",
      contentIndex: 0,
      content: "**Inspecting key files**",
      partial: partialAssistant,
    });
    block.settle();
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /Inspecting key files/);
    assert.doesNotMatch(frame, /\*\*/);
    const content = setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text === "Inspecting key files");
    assert.ok(content !== undefined);
    assert.equal(rgbToHex(content.fg), theme.dim);
  });

  void test("settling an interrupted stream freezes reasoning and stops activity", async () => {
    const block = new ConversationTurnBlock(transcript);
    block.updateAssistant({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "checking state",
      partial: partialAssistant,
    });
    block.settle("aborted");
    const frame = await renderHighlightedFrame(setup);
    assert.match(frame, /Thought[\s\S]*checking state[\s\S]*Stopped/);
    assert.doesNotMatch(frame, /Thinking|Working/);
    assert.match(frame, /checking state/);
  });

  void test("auth URLs stay complete, open on click, and select on drag", async () => {
    const url =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access";
    const styled = authUrlText(url, theme.user);
    assert.equal(styled.chunks.map((chunk) => chunk.text).join(""), url);
    assert.equal(styled.chunks[0]?.link?.url, url);

    const deviceCodeStyled = authUrlText(url, theme.user, "Visit ");
    assert.equal(deviceCodeStyled.chunks.map((chunk) => chunk.text).join(""), `Visit ${url}`);
    assert.equal(deviceCodeStyled.chunks[1]?.link?.url, url);

    const opened: string[] = [];
    const authUrl = appendAuthUrl(transcript, {
      url,
      openUrl: (clickedUrl) => opened.push(clickedUrl),
    });
    await setup.renderOnce();
    const visible = setup.captureCharFrame().replaceAll(/[\s█]/g, "");
    assert.equal(visible, url);

    await setup.mockMouse.click(authUrl.x, authUrl.y);
    assert.deepEqual(opened, [url]);
    assert.equal(setup.renderer.hasSelection, false);

    // A drag covers the column it is released on, so ending four columns over
    // takes five characters. OpenTUI 0.5.7 made that endpoint inclusive; before
    // it, releasing on a character left that character out.
    const dragColumns = 4;
    const dragged = url.slice(0, dragColumns + 1);
    await setup.mockMouse.drag(authUrl.x, authUrl.y, authUrl.x + dragColumns, authUrl.y);
    assert.deepEqual(opened, [url]);
    assert.equal(setup.renderer.hasSelection, true);

    const copied: string[] = [];
    const originalCopy = setup.renderer.copyToClipboardOSC52.bind(setup.renderer);
    setup.renderer.copyToClipboardOSC52 = (text) => {
      copied.push(text);
      return true;
    };
    const dispose = registerSelectionLayer(createChatKeymap(setup.renderer), setup.renderer);
    try {
      setup.mockInput.pressCtrlC();
      assert.deepEqual(copied, [dragged]);
      assert.equal(setup.renderer.hasSelection, false);
    } finally {
      dispose();
      setup.renderer.copyToClipboardOSC52 = originalCopy;
    }
  });
});
