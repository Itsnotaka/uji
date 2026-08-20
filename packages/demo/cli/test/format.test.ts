import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Entry } from "@june/core";
import type { Message, Usage } from "@june/schema";
import {
  compactArgs,
  describeToolCall,
  diffFromDetails,
  displayDelta,
  omittedLabel,
  parseSlashCommand,
  parseToolArgs,
  partsText,
  POWERLINE_SEPARATOR,
  powerlineSegments,
  powerlineText,
  previewLines,
  shortId,
  transcriptFromEntries,
} from "../src/format.ts";
import type { PowerlineState } from "../src/format.ts";

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
  });
  void test("rejects chat text, a bare slash, and invalid command names", () => {
    assert.equal(parseSlashCommand("hello"), undefined);
    assert.equal(parseSlashCommand("/"), undefined);
    assert.equal(parseSlashCommand("/not_valid"), undefined);
  });
});

void describe("displayDelta", () => {
  void test("reads Pi-style assistant events", () => {
    assert.deepEqual(
      displayDelta({ assistantMessageEvent: { type: "thinking_delta", delta: "checking" } }),
      { kind: "reasoning", text: "checking" },
    );
  });
  void test("ignores lifecycle updates", () => {
    assert.equal(displayDelta({ assistantMessageEvent: { type: "text_end" } }), undefined);
  });
});

void describe("describeToolCall", () => {
  void test("bash renders as a shell prompt", () => {
    assert.equal(describeToolCall("bash", '{"command":"git status"}').title, "$ git status");
  });
  void test("bash with no command falls back to the remaining args", () => {
    assert.equal(describeToolCall("bash", '{"timeout":5}').title, "$ timeout=5");
  });
  void test("other tools lead with the path and never double-encode", () => {
    const summary = describeToolCall("read", '{"path":"src/index.ts","offset":10}');
    assert.equal(summary.title, "read src/index.ts offset=10");
    assert.ok(!summary.title.includes('\\"'));
  });
  void test("grep leads with the pattern", () => {
    assert.equal(
      describeToolCall("grep", '{"pattern":"TODO","path":"src"}').title,
      "grep TODO path=src",
    );
  });
  void test("keeps a different primary key even when its value is duplicated", () => {
    assert.equal(
      describeToolCall("grep", '{"pattern":"src","path":"src"}').title,
      "grep src path=src",
    );
  });
  void test("write keeps the content out of the title and in the detail", () => {
    const summary = describeToolCall("write", '{"path":"a.txt","content":"hello\\nworld"}');
    assert.equal(summary.title, "write a.txt");
    assert.equal(summary.detail, "hello\nworld");
  });
  void test("non-object args are shown raw", () => {
    assert.equal(describeToolCall("custom", "plain").title, "custom plain");
    assert.equal(describeToolCall("custom", undefined).title, "custom");
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
});

void describe("diffFromDetails", () => {
  void test("reads a string diff", () => {
    assert.equal(diffFromDetails({ diff: "--- a\n+++ b" }), "--- a\n+++ b");
  });
  void test("ignores missing, empty, or non-string diffs", () => {
    assert.equal(diffFromDetails(undefined), undefined);
    assert.equal(diffFromDetails({ diff: "" }), undefined);
    assert.equal(diffFromDetails({ diff: 3 }), undefined);
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

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
      { kind: "user", text: "list files" },
      { kind: "thinking", text: "need ls" },
      {
        kind: "tool",
        callId: "c1",
        toolName: "bash",
        args: { command: "ls" },
        output: "a.ts\nb.ts",
      },
      { kind: "assistant", text: "Two files." },
      { kind: "note", text: "model → gpt-5.5" },
    ]);
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
});

const state: PowerlineState = {
  runState: "idle",
  workspace: "june",
  branch: "main",
  dirty: true,
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  effort: "medium",
  session: "s_abc123",
  queued: 0,
};

const join = (...parts: string[]): string => ` ${parts.join(` ${POWERLINE_SEPARATOR} `)}`;

void describe("powerline", () => {
  void test("text carries every fact without color", () => {
    assert.equal(
      powerlineText(state),
      join("idle", "june main*", "openai-codex/gpt-5.6-luna medium", "s_abc123"),
    );
  });
  void test("shows the running tool and a queued count only when nonzero", () => {
    const segments = powerlineSegments({
      ...state,
      runState: "running tool",
      toolName: "bash",
      queued: 2,
    });
    assert.equal(segments[0]?.text, "running bash");
    assert.equal(segments.at(-1)?.text, "2 queued");
    assert.equal(
      powerlineSegments(state).some((s) => s.tone === "queue"),
      false,
    );
  });
  void test("omits branch and effort when unknown", () => {
    const text = powerlineText({ ...state, branch: undefined, effort: undefined, dirty: false });
    assert.equal(text, join("idle", "june", "openai-codex/gpt-5.6-luna", "s_abc123"));
  });
  void test("shortId truncates long ids", () => {
    assert.equal(shortId("2026-08-20T16-37-03.311Z-s_895ea158"), "s_895ea158");
    assert.equal(shortId("s_0123456789abcdef"), "s_0123456789");
    assert.equal(shortId("short"), "short");
  });
});
