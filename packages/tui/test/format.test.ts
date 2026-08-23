import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Entry } from "@uji-ai/core";
import type { Message, Usage } from "@uji-ai/schema";
import {
  compactArgs,
  describeToolCall,
  diffFromDetails,
  diffFromOutput,
  diffStat,
  formatDuration,
  hintGroups,
  omittedLabel,
  parseComposerSubmission,
  parseSlashCommand,
  parseToolArgs,
  partsText,
  powerlineSegments,
  powerlineText,
  previewLines,
  relativePath,
  resultSummary,
  shortId,
  spinnerFrame,
  transcriptFromEntries,
  transcriptItemIndex,
} from "../src/format.ts";
import type { PowerlineState } from "../src/format.ts";
import { BUSY_HINTS, GLYPHS, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../src/constants.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

void describe("parseToolArgs", () => {
  void test("decodes the JSON string the loop emits", () => {
    assert.deepEqual(parseToolArgs('{"command":"ls -la"}'), { command: "ls -la" });
  });
  void test("returns malformed strings untouched", () => {
    assert.equal(parseToolArgs("{not json"), "{not json");
  });
  void test("passes objects through", () => {
    assert.deepEqual(parseToolArgs({ path: "a" }), { path: "a" });
  });
});

void describe("parseSlashCommand", () => {
  void test("normalizes the command and preserves a spaced argument", () => {
    assert.deepEqual(parseSlashCommand("  /SEARCH  auth failure in callback  "), {
      name: "search",
      argument: "auth failure in callback",
    });
  });
  void test("accepts a command without an argument", () => {
    assert.deepEqual(parseSlashCommand("/provider"), { name: "provider", argument: "" });
    assert.deepEqual(parseSlashCommand("/3d-modeling inspect this"), {
      name: "3d-modeling",
      argument: "inspect this",
    });
  });
  void test("rejects chat text, a bare slash, and invalid command names", () => {
    assert.equal(parseSlashCommand("hello"), undefined);
    assert.equal(parseSlashCommand("/"), undefined);
    assert.equal(parseSlashCommand("/not_valid"), undefined);
  });
  void test("treats slash-prefixed source code as chat text", () => {
    const source = `/** A before_run_end hook that keeps returning a follow-up is a bug in the plugin; this is the backstop. */
const MAX_HOOK_FOLLOW_UPS = 10;`;
    assert.equal(parseSlashCommand(source), undefined);
    assert.equal(parseSlashCommand("/** comment */"), undefined);
  });
});

void describe("parseComposerSubmission", () => {
  void test("routes slash-prefixed source code to chat and commands to dispatch", () => {
    const source = `/** A before_run_end hook that keeps returning a follow-up is a bug in the plugin; this is the backstop. */
const MAX_HOOK_FOLLOW_UPS = 10;`;
    assert.deepEqual(parseComposerSubmission(source), { kind: "prompt", text: source });
    assert.deepEqual(parseComposerSubmission("/reload"), {
      kind: "command",
      command: { name: "reload", argument: "" },
    });
    assert.deepEqual(parseComposerSubmission("/unknown value"), {
      kind: "command",
      command: { name: "unknown", argument: "value" },
    });
    assert.deepEqual(parseComposerSubmission("  "), { kind: "empty" });
  });
});

void describe("describeToolCall", () => {
  void test("bash reads as a verb and a command", () => {
    const summary = describeToolCall("bash", '{"command":"git status"}');
    assert.equal(summary.title, "Run git status");
    assert.equal(summary.operandKind, "command");
  });
  void test("bash with no command falls back to the remaining args", () => {
    assert.equal(describeToolCall("bash", '{"timeout":5}').title, "Run timeout=5");
  });
  void test("other tools lead with the path and never double-encode", () => {
    const summary = describeToolCall("read", '{"path":"src/index.ts","offset":10}');
    assert.equal(summary.title, "Read src/index.ts offset=10");
    assert.equal(summary.path, "src/index.ts");
    assert.equal(summary.operandKind, "path");
    assert.ok(!summary.title.includes('\\"'));
  });
  void test("grep leads with the pattern", () => {
    const summary = describeToolCall("grep", '{"pattern":"TODO","path":"src"}');
    assert.equal(summary.title, "Search TODO path=src");
    assert.equal(summary.operandKind, "pattern");
  });
  void test("keeps a different primary key even when its value is duplicated", () => {
    assert.equal(
      describeToolCall("grep", '{"pattern":"src","path":"src"}').title,
      "Search src path=src",
    );
  });
  void test("write keeps the content out of the title and in the body", () => {
    const summary = describeToolCall("write", '{"path":"a.txt","content":"hello\\nworld"}');
    assert.equal(summary.title, "Write a.txt");
    assert.equal(summary.body, "hello\nworld");
  });
  void test("an unknown tool keeps its own name as the verb", () => {
    assert.equal(describeToolCall("custom", "plain").title, "custom plain");
    assert.equal(describeToolCall("custom", undefined).title, "custom");
  });
});

void describe("formatDuration", () => {
  void test("keeps a decimal under ten seconds, then whole units", () => {
    assert.equal(formatDuration(500), "0.5s");
    assert.equal(formatDuration(9_900), "9.9s");
    assert.equal(formatDuration(32_000), "32s");
    assert.equal(formatDuration(80_000), "1m20s");
    assert.equal(formatDuration(3_720_000), "1h2m");
  });
});

void describe("spinnerFrame", () => {
  void test("advances one frame per interval and wraps", () => {
    assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
    assert.equal(spinnerFrame(SPINNER_INTERVAL_MS), SPINNER_FRAMES[1]);
    assert.equal(spinnerFrame(SPINNER_INTERVAL_MS * SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
  });
  void test("every frame is one column wide, so the label never shifts", () => {
    for (const frame of SPINNER_FRAMES) assert.equal(Array.from(frame).length, 1);
  });
});

void describe("resultSummary", () => {
  void test("counts lines only when there is more than one", () => {
    assert.equal(resultSummary(""), undefined);
    assert.equal(resultSummary("one line"), undefined);
    assert.equal(resultSummary("a\nb\nc\n"), "3 lines");
  });
});

void describe("compactArgs", () => {
  void test("clips long values and flattens newlines", () => {
    const text = compactArgs({ text: `${"x".repeat(60)}\nmore` });
    assert.ok(text.startsWith("text="));
    assert.ok(text.endsWith("…"));
    assert.ok(!text.includes("\n"));
  });
  void test("formats values JSON cannot encode", () => {
    assert.equal(compactArgs(Symbol("value")), "Symbol(value)");
  });
});

void describe("previewLines", () => {
  void test("keeps short output whole", () => {
    assert.deepEqual(previewLines("a\nb\n", 4), { text: "a\nb", omitted: 0 });
  });
  void test("caps and counts omitted lines", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    const preview = previewLines(lines, 8);
    assert.equal(preview.text.split("\n").length, 8);
    assert.equal(preview.omitted, 4);
    assert.equal(omittedLabel(preview.omitted), "… 4 more lines");
    assert.equal(omittedLabel(1), "… 1 more line");
  });
  void test("empty output is empty", () => {
    assert.deepEqual(previewLines("\n\n", 3), { text: "", omitted: 0 });
  });
  void test("a tail keeps the end of long output and marks the gap inline", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join("\n");
    const preview = previewLines(lines, 2, 3);
    assert.equal(preview.omitted, 0);
    assert.deepEqual(preview.text.split("\n"), [
      "line 0",
      "line 1",
      "… 7 more lines",
      "line 9",
      "line 10",
      "line 11",
    ]);
  });
});

void describe("diffStat", () => {
  void test("counts changed lines and ignores the file headers", () => {
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n kept\n-gone\n+new\n+also new\n";
    assert.deepEqual(diffStat(patch), { added: 2, removed: 1 });
  });
});

void describe("relativePath", () => {
  void test("drops the working directory prefix and leaves other paths alone", () => {
    assert.equal(relativePath("/work/repo/src/a.ts", "/work/repo"), "src/a.ts");
    assert.equal(relativePath("/etc/hosts", "/work/repo"), "/etc/hosts");
  });
});

void describe("diffFromDetails", () => {
  void test("prefers the unified patch over the display diff", () => {
    assert.equal(
      diffFromDetails({ diff: " 1 kept\n-2 gone\n+2 new", patch: "--- a\n+++ b" }),
      "--- a\n+++ b",
    );
  });
  void test("reads a string diff that is already unified", () => {
    assert.equal(diffFromDetails({ diff: "--- a\n+++ b" }), "--- a\n+++ b");
  });
  void test("ignores the line-numbered display diff", () => {
    assert.equal(diffFromDetails({ diff: " 1 kept\n-2 gone\n+2 new" }), undefined);
  });
  void test("ignores missing, empty, or non-string diffs", () => {
    assert.equal(diffFromDetails(undefined), undefined);
    assert.equal(diffFromDetails({ diff: "" }), undefined);
    assert.equal(diffFromDetails({ diff: 3 }), undefined);
    assert.equal(diffFromDetails({ patch: 3 }), undefined);
  });
});

void describe("diffFromOutput", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-const value = 1;",
    "+const value = 2;",
  ].join("\n");

  void test("recognizes a git patch and keeps its source path", () => {
    assert.deepEqual(diffFromOutput(patch), {
      files: [{ patch, path: "src/a.ts" }],
    });
  });

  void test("separates shell output appended after the patch", () => {
    assert.deepEqual(diffFromOutput(`${patch}\n M package.json\n?? notes.txt\n`), {
      files: [{ patch, path: "src/a.ts" }],
      after: " M package.json\n?? notes.txt",
    });
  });

  void test("splits multi-file git output so each file keeps its grammar", () => {
    const jsonPatch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      '-{"old": true}',
      '+{"new": true}',
    ].join("\n");
    assert.deepEqual(diffFromOutput(`${patch}\n${jsonPatch}`), {
      files: [
        { patch, path: "src/a.ts" },
        { patch: jsonPatch, path: "package.json" },
      ],
    });
  });

  void test("ignores prose and incomplete patches", () => {
    assert.equal(diffFromOutput("--- old\n+++ new\nnot a hunk"), undefined);
    assert.equal(diffFromOutput("plain output"), undefined);
  });
});

void describe("partsText", () => {
  void test("flattens text parts and marks images", () => {
    assert.equal(
      partsText([
        { type: "text", text: "hi " },
        { type: "image", data: "", mimeType: "image/png" },
      ]),
      "hi [image]",
    );
    assert.equal(partsText("plain"), "plain");
    assert.equal(partsText(undefined), "");
  });
});

function entry(id: string, message: Message, seq: number): Entry {
  return {
    type: "message",
    id,
    seq,
    parentId: seq === 0 ? null : `e${String(seq - 1)}`,
    timestamp: seq,
    message,
  };
}

void describe("transcriptFromEntries", () => {
  void test("maps a branch to items and pairs tool calls with outputs", () => {
    const items = transcriptFromEntries([
      entry("e0", { role: "user", content: "list files", timestamp: 0 }, 0),
      entry(
        "e1",
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "need ls" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          usage,
          stopReason: "toolUse",
          timestamp: 1,
        },
        1,
      ),
      entry(
        "e2",
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [{ type: "text", text: "a.ts\nb.ts" }],
          details: { patch: "--- a/a.ts\n+++ b/a.ts" },
          isError: false,
          timestamp: 2,
        },
        2,
      ),
      entry(
        "e3",
        {
          role: "assistant",
          content: [{ type: "text", text: "Two files." }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          usage,
          stopReason: "stop",
          timestamp: 3,
        },
        3,
      ),
      {
        type: "model_change",
        id: "e4",
        seq: 4,
        parentId: "e3",
        timestamp: 4,
        modelId: "gpt-5.5",
      },
    ]);
    assert.deepEqual(items, [
      {
        kind: "turn",
        id: "e0",
        entryIds: ["e0", "e1", "e2", "e3"],
        outcome: "completed",
        parts: [
          { kind: "user", entryId: "e0", parentId: null, content: "list files" },
          { kind: "thinking", text: "need ls" },
          {
            kind: "tool",
            callId: "c1",
            toolName: "bash",
            args: { command: "ls" },
            output: "a.ts\nb.ts",
            details: { patch: "--- a/a.ts\n+++ b/a.ts" },
            isError: false,
          },
          { kind: "assistant", text: "Two files." },
        ],
      },
    ]);
    assert.equal(transcriptItemIndex(items, "e0"), 0);
    assert.equal(transcriptItemIndex(items, "e2"), 0);
    assert.equal(transcriptItemIndex(items, "missing"), -1);
  });

  void test("keeps model and thinking changes out of the conversation transcript", () => {
    const items = transcriptFromEntries([
      {
        type: "model_change",
        id: "e0",
        seq: 0,
        parentId: null,
        timestamp: 0,
        modelId: "gpt-5.6-sol",
      },
      {
        type: "thinking_level_change",
        id: "e1",
        seq: 1,
        parentId: "e0",
        timestamp: 1,
        thinkingLevel: "high",
      },
    ]);
    assert.deepEqual(items, []);
  });

  void test("renders compaction checkpoints and known custom notes", () => {
    const items = transcriptFromEntries([
      entry("e0", { role: "user", content: "list files", timestamp: 0 }, 0),
      {
        type: "compaction",
        id: "e1",
        seq: 1,
        parentId: "e0",
        timestamp: 1,
        summary: "Worked on the parser.",
        retainedTail: [],
        tokensBefore: 42000,
        fromHook: false,
      },
      {
        type: "custom",
        id: "e2",
        seq: 2,
        parentId: "e1",
        timestamp: 2,
        customType: "provider_change",
        data: { providerId: "openai-codex" },
      },
      {
        type: "custom",
        id: "e3",
        seq: 3,
        parentId: "e2",
        timestamp: 3,
        customType: "cwd_change",
        data: { cwd: "/tmp/project" },
      },
      {
        type: "custom",
        id: "e4",
        seq: 4,
        parentId: "e3",
        timestamp: 4,
        customType: "something_else",
        data: { x: 1 },
      },
    ]);
    assert.deepEqual(items, [
      {
        kind: "turn",
        id: "e0",
        entryIds: ["e0", "e1"],
        outcome: "completed",
        parts: [
          { kind: "user", entryId: "e0", parentId: null, content: "list files" },
          { kind: "compaction", summary: "Worked on the parser.", tokensBefore: 42000 },
        ],
      },
      { kind: "note", entryIds: ["e2"], text: "Provider → openai-codex" },
      { kind: "note", entryIds: ["e3"], text: "Directory → /tmp/project" },
    ]);
  });

  void test("caps long compaction summaries", () => {
    const items = transcriptFromEntries([
      {
        type: "compaction",
        id: "e0",
        seq: 0,
        parentId: null,
        timestamp: 0,
        summary: Array.from({ length: 45 }, (_, index) => `line ${String(index)}`).join("\n"),
        retainedTail: [],
        tokensBefore: 900,
        fromHook: false,
      },
    ]);
    const item = items[0];
    if (item?.kind !== "compaction") throw new Error("expected a compaction item");
    assert.equal(item.summary.split("\n").length, 41);
    assert.ok(item.summary.endsWith(omittedLabel(5)));
    assert.equal(item.tokensBefore, 900);
  });

  void test("drops empty reasoning and assistant items", () => {
    const items = transcriptFromEntries([
      entry(
        "e0",
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "" },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          usage,
          stopReason: "stop",
          timestamp: 0,
        },
        0,
      ),
    ]);
    assert.deepEqual(items, []);
  });

  void test("preserves a failed turn outcome for restored sessions", () => {
    const items = transcriptFromEntries([
      entry("e0", { role: "user", content: "try it", timestamp: 0 }, 0),
      entry(
        "e1",
        {
          role: "assistant",
          content: [],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          usage,
          stopReason: "error",
          errorMessage: "provider failed",
          timestamp: 1,
        },
        1,
      ),
    ]);
    const turn = items[0];
    if (turn?.kind !== "turn") throw new Error("expected a turn");
    assert.equal(turn.outcome, "failed");
    assert.deepEqual(turn.entryIds, ["e0", "e1"]);
    assert.deepEqual(turn.parts.at(-1), { kind: "note", text: "Error: provider failed" });
  });
});

const state: PowerlineState = {
  runState: "idle",
  workspace: "uji",
  branch: "main",
  dirty: true,
  model: "gpt-5.6-luna",
  effort: "medium",
  fast: false,
  queued: 0,
};

const join = (...parts: string[]): string => ` ${parts.join(` ${GLYPHS.separator} `)}`;

void describe("powerline", () => {
  void test("idle status keeps workspace, model, and thinking mode", () => {
    assert.equal(powerlineText(state), join("uji main*", "gpt-5.6-luna", "medium"));
  });
  void test("uses the current model slug exactly once", () => {
    const text = powerlineText({ ...state, model: "gpt-5.6-sol" });
    assert.equal(text.match(/gpt-5\.6-sol/g)?.length, 1);
    assert.doesNotMatch(text, /gpt-5\.6-luna/);
  });
  void test("keeps run state out of chrome and shows a queued count only when nonzero", () => {
    const segments = powerlineSegments({
      ...state,
      runState: "running tool",
      queued: 2,
    });
    assert.equal(segments[0]?.text, "uji main*");
    assert.equal(segments.at(-1)?.text, "2 queued");
    assert.equal(
      powerlineSegments(state).some((s) => s.tone === "queue"),
      false,
    );
  });
  void test("does not duplicate compaction in the composer", () => {
    assert.deepEqual(
      powerlineSegments({ ...state, runState: "compacting" }),
      powerlineSegments(state),
    );
  });
  void test("shows fast inference with the thinking mode", () => {
    assert.equal(powerlineSegments({ ...state, fast: true })[2]?.text, "medium fast");
  });
  void test("omits branch and effort when unknown", () => {
    const text = powerlineText({ ...state, branch: undefined, effort: undefined, dirty: false });
    assert.equal(text, join("uji", "gpt-5.6-luna"));
  });
  void test("shows last-turn tokens and context share after the model", () => {
    assert.deepEqual(powerlineSegments({ ...state, tokens: 12_300, pct: 38 })[3], {
      text: "12.3k tokens · 38% context",
      tone: "usage",
    });
    assert.equal(
      powerlineSegments({ ...state, tokens: 1_234_000, pct: 100 })[3]?.text,
      "1.2m tokens · 100% context",
    );
  });
  void test("omits the share when the window is unknown and hides empty usage", () => {
    assert.equal(powerlineSegments({ ...state, tokens: 940 })[3]?.text, "940 tokens");
    assert.equal(
      powerlineSegments(state).some((s) => s.tone === "usage"),
      false,
    );
    assert.equal(
      powerlineSegments({ ...state, tokens: 0, pct: 0 }).some((s) => s.tone === "usage"),
      false,
    );
  });
  void test("a narrow border drops usage before workspace and mode", () => {
    const usage = { ...state, tokens: 12_300, pct: 38 };
    const full = join("uji main*", "gpt-5.6-luna", "medium", "12.3k tokens · 38% context");
    assert.equal(
      powerlineText(usage, full.length - 1),
      join("uji main*", "gpt-5.6-luna", "medium"),
    );
    const narrower = powerlineText(usage, 20);
    assert.ok(narrower.length <= 20, narrower);
    assert.ok(narrower.includes("gpt-5.6-luna"), narrower);
    assert.ok(!narrower.includes("tokens"), narrower);
    assert.ok(!narrower.includes("uji"), narrower);
  });
  void test("a narrow active status keeps the model", () => {
    const narrow = powerlineText({ ...state, runState: "working" }, 26);
    assert.ok(narrow.length <= 26, narrow);
    assert.ok(narrow.includes("gpt-5.6-luna"), narrow);
    assert.ok(!narrow.includes("working"), narrow);
    assert.ok(!narrow.includes("uji"), narrow);
  });
  void test("shortId truncates long ids", () => {
    assert.equal(shortId("2026-08-20T16-37-03.311Z-s_895ea158"), "s_895ea158");
    assert.equal(shortId("s_0123456789abcdef"), "s_0123456789");
    assert.equal(shortId("short"), "short");
  });
});

void describe("hint groups", () => {
  void test("splits every hint row into a keycap and what it does", () => {
    assert.deepEqual(hintGroups("? commands \u00b7 shift+tab thinking"), [
      { key: "?", label: "commands" },
      { key: "shift+tab", label: "thinking" },
    ]);
    assert.deepEqual(hintGroups("esc stop \u00b7 ctrl+enter queue \u00b7 \u2191 follow-ups"), [
      { key: "esc", label: "stop" },
      { key: "ctrl+enter", label: "queue" },
      { key: "\u2191", label: "follow-ups" },
    ]);
    assert.deepEqual(hintGroups(BUSY_HINTS), [
      { key: "esc", label: "stop" },
      { key: "enter", label: "steer" },
      { key: "ctrl+enter", label: "queue" },
      { key: "ctrl+q", label: "queued" },
    ]);
    assert.deepEqual(hintGroups("ctrl+c copy selection or cancel"), [
      { key: "ctrl+c", label: "copy selection or cancel" },
    ]);
    assert.deepEqual(hintGroups(""), []);
  });
});
