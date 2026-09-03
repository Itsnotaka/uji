import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Message, Usage } from "@uji-ai/schema";
import {
  appendTranscriptEntry,
  appendTurnChanges,
  changesFromTurns,
  createPresenter,
  EMPTY_CHANGES,
  EMPTY_TRANSCRIPT,
  emptyUsageSummary,
  mergeUsageSummaries,
  presentCustomEntry,
  presentTool,
  projectRunUsage,
  projectUsage,
  sessionDirectoryEntryFromLog,
  toolViewOf,
  transcriptFromEntries,
  turnPartId,
  type ToolTurnPart,
} from "../src/index.ts";
import type { Entry, LogItem } from "../src/store.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageEntry(id: string, message: Message, seq: number): Entry {
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
  void test("groups messages and pairs tool calls with their results", () => {
    const turns = transcriptFromEntries([
      messageEntry("e0", { role: "user", content: "list files", timestamp: 0 }, 0),
      messageEntry(
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
      messageEntry(
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
      messageEntry(
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
    ]);

    assert.deepEqual(turns, [
      {
        kind: "turn",
        id: "e0",
        outcome: "completed",
        // The user entry starts the turn and the last assistant entry ends it.
        startedAt: 0,
        durationMs: 3,
        parts: [
          { kind: "user", entryId: "e0", parentId: null, content: "list files" },
          { kind: "thinking", entryId: "e1", contentIndex: 0, text: "need ls" },
          {
            kind: "tool",
            callId: "c1",
            toolName: "bash",
            args: { command: "ls" },
            result: {
              entryId: "e2",
              output: "a.ts\nb.ts",
              details: { patch: "--- a/a.ts\n+++ b/a.ts" },
              isError: false,
            },
          },
          {
            kind: "assistant",
            entryId: "e3",
            contentIndex: 0,
            text: "Two files.",
          },
        ],
      },
    ]);
  });

  void test("incremental and batch projection share stable part identity", () => {
    const entries = [
      messageEntry("e0", { role: "user", content: "go", timestamp: 0 }, 0),
      messageEntry(
        "e1",
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "text", text: "done" },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          usage,
          stopReason: "stop",
          timestamp: 1,
        },
        1,
      ),
    ];
    const batch = transcriptFromEntries(entries);
    const incremental = entries.reduce(appendTranscriptEntry, EMPTY_TRANSCRIPT);

    assert.deepEqual(incremental.items, batch);
    // The harness and the session watcher may both deliver one commit.
    for (const entry of entries)
      assert.equal(appendTranscriptEntry(incremental, entry), incremental);
    const turn = batch[0];
    assert.ok(turn?.kind === "turn");
    assert.deepEqual(turn.parts.map(turnPartId), ["user:e0", "thinking:e1:0", "assistant:e1:1"]);
  });

  void test("spans a turn forward only, whichever way the host clock moves", () => {
    const [turn] = transcriptFromEntries([
      {
        ...messageEntry("e0", { role: "user", content: "go", timestamp: 0 }, 0),
        timestamp: 10_000,
      },
      {
        ...messageEntry(
          "e1",
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.6-luna",
            usage,
            stopReason: "stop",
            timestamp: 1,
          },
          1,
        ),
        // NTP nudges the host clock mid-turn.
        timestamp: 9_000,
      },
    ]);

    assert.ok(turn?.kind === "turn");
    assert.equal(turn.startedAt, 10_000);
    assert.equal(turn.durationMs, 0);
  });

  void test("keeps history around compactions and preserves model and custom markers", () => {
    const latestCompaction: Entry = {
      type: "compaction",
      id: "e3",
      seq: 3,
      parentId: "e2",
      timestamp: 3,
      summary: "Keep this checkpoint.",
      retainedTail: [],
      tokensBefore: 42_000,
      fromHook: false,
    };
    const modelChange: Entry = {
      type: "model_change",
      id: "e4",
      seq: 4,
      parentId: "e3",
      timestamp: 4,
      modelId: "gpt-5.6-sol",
    };
    const custom: Entry = {
      type: "custom",
      id: "e6",
      seq: 6,
      parentId: "e5",
      timestamp: 6,
      customType: "cwd_change",
      data: { cwd: "/tmp/project" },
    };
    const turns = transcriptFromEntries([
      messageEntry("e0", { role: "user", content: "drop me", timestamp: 0 }, 0),
      {
        type: "compaction",
        id: "e1",
        seq: 1,
        parentId: "e0",
        timestamp: 1,
        summary: "Old checkpoint.",
        retainedTail: [],
        tokensBefore: 20_000,
        fromHook: false,
      },
      messageEntry("e2", { role: "user", content: "also dropped", timestamp: 2 }, 2),
      latestCompaction,
      modelChange,
      {
        type: "thinking_level_change",
        id: "e5",
        seq: 5,
        parentId: "e4",
        timestamp: 5,
        thinkingLevel: "high",
      },
      custom,
      messageEntry("e7", { role: "user", content: "keep me", timestamp: 7 }, 7),
    ]);

    assert.deepEqual(turns, [
      {
        kind: "turn",
        id: "e0",
        outcome: "completed",
        startedAt: 0,
        durationMs: 0,
        parts: [{ kind: "user", entryId: "e0", parentId: null, content: "drop me" }],
      },
      {
        kind: "compaction",
        entry: {
          type: "compaction",
          id: "e1",
          seq: 1,
          parentId: "e0",
          timestamp: 1,
          summary: "Old checkpoint.",
          retainedTail: [],
          tokensBefore: 20_000,
          fromHook: false,
        },
      },
      {
        kind: "turn",
        id: "e2",
        outcome: "completed",
        startedAt: 2,
        durationMs: 0,
        parts: [{ kind: "user", entryId: "e2", parentId: "e1", content: "also dropped" }],
      },
      { kind: "compaction", entry: latestCompaction },
      { kind: "model_change", entry: modelChange },
      { kind: "custom", entry: custom },
      {
        kind: "turn",
        id: "e7",
        outcome: "completed",
        startedAt: 7,
        durationMs: 0,
        parts: [{ kind: "user", entryId: "e7", parentId: "e6", content: "keep me" }],
      },
    ]);
  });

  void test("keeps failed and unmatched tool results renderable", () => {
    const turns = transcriptFromEntries([
      messageEntry(
        "e0",
        {
          role: "toolResult",
          toolCallId: "missing",
          toolName: "read",
          content: [{ type: "image", data: "abc", mimeType: "image/png" }],
          isError: true,
          timestamp: 0,
        },
        0,
      ),
      messageEntry(
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

    assert.deepEqual(turns, [
      {
        kind: "turn",
        id: "e0",
        outcome: "failed",
        startedAt: 0,
        durationMs: 1,
        parts: [
          {
            kind: "tool",
            callId: "missing",
            toolName: "read",
            result: { entryId: "e0", output: "[image]", isError: true },
          },
          { kind: "note", entryId: "e1", text: "Error: provider failed" },
        ],
      },
    ]);
  });
});

void describe("sessionDirectoryEntryFromLog", () => {
  void test("projects picker fields and heads", () => {
    const log: LogItem[] = [
      { kind: "fact", seq: 1, fact: "name", name: "First name" },
      {
        kind: "entry",
        seq: 2,
        head: "main",
        entry: messageEntry("e2", { role: "user", content: "Initial request", timestamp: 20 }, 2),
      },
      {
        kind: "entry",
        seq: 3,
        head: "main",
        entry: messageEntry(
          "e3",
          {
            role: "assistant",
            content: [{ type: "text", text: "Latest answer" }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.6-luna",
            usage,
            stopReason: "stop",
            timestamp: 30,
          },
          3,
        ),
      },
      { kind: "head", seq: 4, head: "main", leafId: "e3", by: "append" },
      { kind: "head", seq: 5, head: "review", leafId: "e2", by: "move" },
      {
        kind: "claim",
        seq: 6,
        event: {
          kind: "acquired",
          claim: {
            head: "main",
            runId: "expired",
            ownerId: "runner-a",
            fence: 1,
            expiresAtMs: 90,
          },
        },
      },
      {
        kind: "claim",
        seq: 7,
        event: {
          kind: "renewed",
          claim: {
            head: "review",
            runId: "run-review",
            ownerId: "runner-b",
            fence: 2,
            expiresAtMs: 200,
          },
        },
      },
      {
        kind: "record",
        seq: 8,
        record: {
          type: "operation_finished",
          id: "finish",
          seq: 8,
          head: "review",
          timestamp: 120,
          runId: "previous-run",
          outcome: "completed",
        },
      },
      { kind: "fact", seq: 9, fact: "name", name: "Named chat" },
    ];

    assert.deepEqual(
      sessionDirectoryEntryFromLog({
        metadata: { id: "session-1", createdAt: 10 },
        log,
      }),
      {
        id: "session-1",
        name: "Named chat",
        preview: "Latest answer",
        lastActivity: 120,
        heads: ["main", "review"],
      },
    );
  });

  void test("returns an empty-session row", () => {
    const log: LogItem[] = [
      {
        kind: "claim",
        seq: 1,
        event: {
          kind: "acquired",
          claim: {
            head: "main",
            runId: "run-1",
            ownerId: "runner-a",
            fence: 1,
            expiresAtMs: 200,
          },
        },
      },
      {
        kind: "claim",
        seq: 2,
        event: {
          kind: "released",
          head: "main",
          runId: "run-1",
          ownerId: "runner-a",
          fence: 1,
        },
      },
    ];

    assert.deepEqual(
      sessionDirectoryEntryFromLog({
        metadata: { id: "empty", createdAt: 10 },
        log,
      }),
      {
        id: "empty",
        lastActivity: 10,
        heads: ["main"],
      },
    );
  });
});

function usageOf(input: number, output: number, costTotal: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
  };
}

function assistantEntry(id: string, model: string, spent: Usage, seq: number): Entry {
  return messageEntry(
    id,
    {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model,
      usage: spent,
      stopReason: "stop",
      timestamp: seq,
    },
    seq,
  );
}

void describe("projectRunUsage", () => {
  void test("sums every usage field in the run ledger", () => {
    const total = projectRunUsage([
      {
        type: "usage",
        id: "r0",
        seq: 0,
        head: "main",
        timestamp: 0,
        runId: "run-1",
        cause: "assistant",
        usage: { ...usageOf(10, 2, 0.1), cacheWrite1h: 3, reasoning: 5 },
      },
      {
        type: "usage",
        id: "r1",
        seq: 1,
        head: "main",
        timestamp: 1,
        runId: "run-1",
        cause: "tool",
        usage: { ...usageOf(4, 1, 0.2), cacheWrite1h: 2, reasoning: 1 },
      },
    ]);
    assert.equal(total.totalTokens, 17);
    assert.equal(total.cost.total.toFixed(1), "0.3");
    assert.equal(total.cacheWrite1h, 5);
    assert.equal(total.reasoning, 6);
  });
});

void describe("projectUsage", () => {
  void test("buckets assistant usage by model, sorted by cost", () => {
    const summary = projectUsage([
      assistantEntry("e0", "cheap-model", usageOf(10, 5, 0.01), 0),
      assistantEntry("e1", "dear-model", usageOf(100, 50, 1), 1),
      assistantEntry("e2", "cheap-model", usageOf(20, 5, 0.02), 2),
    ]);

    assert.deepEqual(
      summary.models.map((row) => [row.model, row.turns, row.usage.input, row.usage.cost.total]),
      [
        ["dear-model", 1, 100, 1],
        ["cheap-model", 2, 30, 0.03],
      ],
    );
    assert.equal(summary.total.totalTokens, 190);
    assert.equal(summary.total.cost.total, 1.03);
  });

  void test("keeps compaction and tool usage out of the model rows", () => {
    const summary = projectUsage([
      assistantEntry("e0", "m", usageOf(10, 10, 0.1), 0),
      messageEntry(
        "e1",
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          usage: usageOf(3, 2, 0.01),
          timestamp: 1,
        },
        1,
      ),
      {
        type: "compaction",
        id: "e2",
        seq: 2,
        parentId: "e1",
        timestamp: 2,
        summary: "s",
        retainedTail: [],
        tokensBefore: 100,
        usage: usageOf(50, 8, 0.05),
        fromHook: false,
      },
    ]);

    assert.deepEqual(
      summary.models.map((row) => row.model),
      ["m"],
    );
    assert.equal(summary.tools.totalTokens, 5);
    assert.equal(summary.compaction.totalTokens, 58);
    assert.equal(summary.total.totalTokens, 83);
    assert.equal(summary.total.cost.total.toFixed(2), "0.16");
  });

  void test("projects nothing from a session without usage", () => {
    const summary = projectUsage([
      messageEntry("e0", { role: "user", content: "hi", timestamp: 0 }, 0),
    ]);
    assert.deepEqual(summary, emptyUsageSummary());
  });
});

void describe("mergeUsageSummaries", () => {
  void test("combines model rows and side buckets across sessions", () => {
    const left = projectUsage([assistantEntry("e0", "a", usageOf(10, 5, 0.2), 0)]);
    const right = projectUsage([
      assistantEntry("e0", "a", usageOf(10, 5, 0.2), 0),
      assistantEntry("e1", "b", usageOf(1, 1, 0.9), 1),
    ]);

    const merged = mergeUsageSummaries(left, right);
    assert.deepEqual(
      merged.models.map((row) => [row.model, row.turns, row.usage.cost.total]),
      [
        ["b", 1, 0.9],
        ["a", 2, 0.4],
      ],
    );
    assert.equal(merged.total.totalTokens, 32);
  });

  void test("merging with empty is identity", () => {
    const summary = projectUsage([assistantEntry("e0", "a", usageOf(10, 5, 0.2), 0)]);
    assert.deepEqual(mergeUsageSummaries(emptyUsageSummary(), summary), summary);
  });
});

function toolPart(overrides: Partial<ToolTurnPart>): ToolTurnPart {
  return { kind: "tool", callId: "c1", toolName: "read", args: undefined, ...overrides };
}

void describe("presentTool", () => {
  void test("a call without a result runs, showing live progress text", () => {
    const presented = presentTool({
      toolName: "bash",
      args: { command: "ls -la" },
      live: { text: "partial", title: "ls -la" },
    });
    assert.equal(presented.status, "running");
    assert.equal(presented.detail, "ls -la");
    assert.equal(presented.title, "ls -la");
    assert.deepEqual(presented.body, { kind: "text", text: "partial" });
  });

  void test("an unknown tool still presents from durable data alone", () => {
    const presented = presentTool({
      toolName: "websearch",
      args: { query: "uji design", limit: 3 },
      result: { output: "1. result", isError: false },
    });
    assert.equal(presented.name, "websearch");
    assert.equal(presented.status, "done");
    assert.equal(presented.detail, "query=uji design limit=3");
    assert.deepEqual(presented.body, { kind: "text", text: "1. result" });
  });

  void test("a settled edit presents its details patch as a diff with stats", () => {
    const patch = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " same",
      "",
    ].join("\n");
    const presented = presentTool({
      toolName: "edit",
      args: { path: "src/x.ts" },
      result: { output: "edited", isError: false, details: { patch } },
    });
    assert.deepEqual(presented.body, {
      kind: "diff",
      patch,
      path: "src/x.ts",
      added: 1,
      removed: 1,
    });
  });

  void test("a failed call shows its output text, never a diff", () => {
    const presented = presentTool({
      toolName: "edit",
      args: { path: "x" },
      result: { output: "boom", isError: true, details: { patch: "--- a\n+++ b\n+x\n" } },
    });
    assert.equal(presented.status, "failed");
    assert.deepEqual(presented.body, { kind: "text", text: "boom" });
  });

  void test("toolViewOf carries a transcript part and overlay into one view", () => {
    const part = toolPart({
      toolName: "read",
      args: { path: "a.txt" },
      result: { entryId: "e9", output: "text", isError: false, title: "a.txt" },
    });
    const presented = presentTool(toolViewOf(part, { text: "ignored once settled" }));
    assert.equal(presented.status, "done");
    assert.equal(presented.title, "a.txt");
    assert.equal(presented.detail, "a.txt");
    assert.deepEqual(presented.body, { kind: "text", text: "text" });
  });
});

void describe("presentCustomEntry", () => {
  void test("an unknown custom entry presents a marker, never a hole", () => {
    assert.deepEqual(
      presentCustomEntry({ customType: "provider_change", data: { providerId: "zai" } }),
      {
        text: "[provider_change] providerId=zai",
      },
    );
    assert.deepEqual(presentCustomEntry({ customType: "checkpoint" }), { text: "[checkpoint]" });
  });
});

void describe("createPresenter", () => {
  void test("a refiner refines its tool and every other tool falls back", () => {
    const presenter = createPresenter({
      tools: {
        websearch: (view, base) =>
          view.result === undefined ? base : { ...base, summary: "Exa · 3 results" },
      },
    });
    const refined = presenter.tool({
      toolName: "websearch",
      result: { output: "…", isError: false },
    });
    assert.equal(refined.summary, "Exa · 3 results");
    const fallback = presenter.tool({ toolName: "read", args: { path: "a" } });
    assert.equal(fallback.summary, undefined);
    assert.equal(fallback.detail, "a");
  });

  void test("a throwing refiner is contained by the base presentation", () => {
    const presenter = createPresenter({
      tools: {
        read: () => {
          throw new Error("broken refiner");
        },
      },
      custom: {
        broken: () => {
          throw new Error("broken refiner");
        },
      },
    });
    assert.equal(presenter.tool({ toolName: "read", args: { path: "a" } }).detail, "a");
    assert.deepEqual(presenter.custom({ customType: "broken" }), { text: "[broken]" });
  });

  void test("only a refiner may hide a custom entry, and only its own", () => {
    const presenter = createPresenter({
      custom: {
        bookkeeping: () => null,
        cwd_change: (entry, base) => {
          const data = entry.data;
          if (
            typeof data === "object" &&
            data !== null &&
            "cwd" in data &&
            typeof data.cwd === "string"
          ) {
            return { text: `Directory → ${data.cwd}` };
          }
          return base;
        },
      },
    });
    assert.equal(presenter.custom({ customType: "bookkeeping" }), null);
    assert.deepEqual(presenter.custom({ customType: "cwd_change", data: { cwd: "/w" } }), {
      text: "Directory → /w",
    });
    assert.deepEqual(presenter.custom({ customType: "novel" }), { text: "[novel]" });
  });
});

function unifiedPatch(path: string, removed: readonly string[], added: readonly string[]): string {
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${String(removed.length)} +1,${String(added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function toolCallEntry(id: string, callIds: readonly string[], seq: number): Entry {
  return messageEntry(
    id,
    {
      role: "assistant",
      content: callIds.map((callId) => ({
        type: "toolCall",
        id: callId,
        name: "edit",
        arguments: {},
      })),
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason: "toolUse",
      timestamp: seq,
    },
    seq,
  );
}

function toolResultEntry(
  id: string,
  callId: string,
  seq: number,
  options: { patch?: string; isError?: boolean } = {},
): Entry {
  return messageEntry(
    id,
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "edit",
      content: [{ type: "text", text: "ok" }],
      details: options.patch === undefined ? { note: "no patch" } : { patch: options.patch },
      isError: options.isError ?? false,
      timestamp: seq,
    },
    seq,
  );
}

void describe("changes", () => {
  void test("folds settled patches into per-file totals, skipping errors and patchless results", () => {
    const turns = transcriptFromEntries([
      messageEntry("e0", { role: "user", content: "edit", timestamp: 0 }, 0),
      toolCallEntry("e1", ["c1"], 1),
      toolResultEntry("e2", "c1", 2, { patch: unifiedPatch("view.md", ["old"], ["new"]) }),
      toolCallEntry("e3", ["c2", "c3", "c4"], 3),
      toolResultEntry("e4", "c2", 4, { patch: unifiedPatch("view.md", [], ["a", "b"]) }),
      toolResultEntry("e5", "c3", 5, {
        patch: unifiedPatch("other.md", ["x"], []),
        isError: true,
      }),
      toolResultEntry("e6", "c4", 6),
    ]);

    assert.deepEqual(changesFromTurns(turns), [
      { path: "view.md", added: 3, removed: 1, lastEntryId: "e4" },
    ]);
  });

  void test("refolding an updated turn counts each settled result once", () => {
    const call = transcriptFromEntries([
      messageEntry("e0", { role: "user", content: "edit", timestamp: 0 }, 0),
      toolCallEntry("e1", ["c1"], 1),
    ]);
    const settled = transcriptFromEntries([
      messageEntry("e0", { role: "user", content: "edit", timestamp: 0 }, 0),
      toolCallEntry("e1", ["c1"], 1),
      toolResultEntry("e2", "c1", 2, { patch: unifiedPatch("view.md", [], ["new"]) }),
    ]);

    // A live client folds the same turn again each time a result settles into
    // it; the folded set makes the repeat a no-op per result.
    let state = EMPTY_CHANGES;
    for (const turn of call) state = appendTurnChanges(state, turn);
    assert.deepEqual(state.files, []);
    for (const turn of settled) state = appendTurnChanges(state, turn);
    assert.deepEqual(state.files, [{ path: "view.md", added: 1, removed: 0, lastEntryId: "e2" }]);
    const again = settled.reduce(appendTurnChanges, state);
    assert.equal(again, state);
  });
});
