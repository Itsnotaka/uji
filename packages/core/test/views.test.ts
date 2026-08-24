import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Message, Usage } from "@uji-ai/schema";
import {
  sessionDirectoryEntryFromLog,
  transcriptFromEntries,
  type Entry,
  type LogItem,
} from "../src/index.ts";

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
        parts: [
          { kind: "user", entryId: "e0", parentId: null, content: "list files" },
          { kind: "thinking", text: "need ls" },
          {
            kind: "tool",
            callId: "c1",
            toolName: "bash",
            args: { command: "ls" },
            result: {
              output: "a.ts\nb.ts",
              details: { patch: "--- a/a.ts\n+++ b/a.ts" },
              isError: false,
            },
          },
          { kind: "assistant", entryId: "e3", text: "Two files." },
        ],
      },
    ]);
  });

  void test("starts at the newest compaction and preserves model and custom markers", () => {
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
      { kind: "compaction", entry: latestCompaction },
      { kind: "model_change", entry: modelChange },
      { kind: "custom", entry: custom },
      {
        kind: "turn",
        id: "e7",
        outcome: "completed",
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
        parts: [
          {
            kind: "tool",
            callId: "missing",
            toolName: "read",
            args: undefined,
            result: { output: "[image]", isError: true },
          },
          { kind: "note", text: "Error: provider failed" },
        ],
      },
    ]);
  });
});

void describe("sessionDirectoryEntryFromLog", () => {
  void test("projects picker fields, heads, and current live claims", () => {
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
      { kind: "head", seq: 4, head: "main", leafId: "e3" },
      { kind: "head", seq: 5, head: "review", leafId: "e2" },
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
        now: 100,
      }),
      {
        id: "session-1",
        name: "Named chat",
        preview: "Latest answer",
        lastActivity: 120,
        heads: ["main", "review"],
        liveClaim: true,
      },
    );
  });

  void test("removes released claims and returns an empty-session row", () => {
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
        now: 100,
      }),
      {
        id: "empty",
        lastActivity: 10,
        heads: ["main"],
        liveClaim: false,
      },
    );
  });
});
