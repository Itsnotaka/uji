/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/assistant-message-frame.test.ts
 * Synced with pi 7ebf9087e.
 *
 * June divergence: the OpenAI Responses round-trip case (`processResponsesStream`)
 * is omitted here; it exercises `api/openai-responses-shared.ts` and belongs with
 * the adapter tests.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent } from "@june/schema";
import {
  type AssistantMessageFrame,
  assistantMessageEventToFrame,
  reduceAssistantMessageFrames,
} from "../src/utils/assistant-message-frame.ts";

function seed(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: 1,
  };
}

function frame(event: AssistantMessageEvent): AssistantMessageFrame {
  const converted = assistantMessageEventToFrame(event);
  if (!converted) throw new Error(`Expected ${event.type} event to produce a frame`);
  return converted;
}

function hasPath(value: unknown, path: string): boolean {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null || !(key in current)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

void describe("assistant message frames", () => {
  void test("uses authoritative text end content and signature", () => {
    const partial = seed();
    const frames: AssistantMessageFrame[] = [frame({ type: "start", partial })];
    partial.content.push({ type: "text", text: "Hello " });
    frames.push(frame({ type: "text_start", contentIndex: 0, partial }));
    partial.content[0] = { type: "text", text: "Hello world", textSignature: "sig-text" };
    frames.push(
      frame({ type: "text_delta", contentIndex: 0, delta: "incorrect", partial }),
      frame({ type: "text_end", contentIndex: 0, content: "Hello world", partial }),
    );

    assert.deepEqual(frames.at(-1), {
      type: "text_end",
      contentIndex: 0,
      content: "Hello world",
      textSignature: "sig-text",
    });
    assert.deepEqual(reduceAssistantMessageFrames(frames)?.content, [
      { type: "text", text: "Hello world", textSignature: "sig-text" },
    ]);
  });

  void test("preserves initial and final thinking metadata, including redaction", () => {
    const partial = seed();
    const frames: AssistantMessageFrame[] = [frame({ type: "start", partial })];
    partial.content.push({
      type: "thinking",
      thinking: "[redacted]",
      thinkingSignature: "encrypted-start",
      redacted: true,
    });
    frames.push(frame({ type: "thinking_start", contentIndex: 0, partial }));
    partial.content[0] = {
      type: "thinking",
      thinking: "[redacted]",
      thinkingSignature: "encrypted-final",
      redacted: true,
    };
    frames.push(frame({ type: "thinking_end", contentIndex: 0, content: "[redacted]", partial }));

    assert.deepEqual(frames.at(-1), {
      type: "thinking_end",
      contentIndex: 0,
      content: "[redacted]",
      thinkingSignature: "encrypted-final",
      redacted: true,
    });
    assert.deepEqual(reduceAssistantMessageFrames(frames)?.content[0], {
      type: "thinking",
      thinking: "[redacted]",
      thinkingSignature: "encrypted-final",
      redacted: true,
    });
  });

  void test("parses unfinished tool JSON once and uses authoritative completed arguments", () => {
    const initialFrames: AssistantMessageFrame[] = [
      { type: "start", partial: seed() },
      {
        type: "toolcall_start",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "initial-id", name: "write", arguments: {} },
      },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"READ' },
    ];

    const initial = reduceAssistantMessageFrames(initialFrames)?.content[0];
    assert.equal(initial?.type, "toolCall");
    assert.deepEqual(initial?.type === "toolCall" ? initial.arguments : undefined, {
      path: "READ",
    });

    const completeFrames: AssistantMessageFrame[] = [
      ...initialFrames,
      { type: "toolcall_delta", contentIndex: 0, delta: 'ME.md","lines":[1,2]}' },
      {
        type: "toolcall_end",
        contentIndex: 0,
        id: "final-id",
        name: "write_file",
        arguments: { path: "final.md", lines: [3] },
        thoughtSignature: "thought",
        namespace: "files",
      },
    ];
    assert.deepEqual(reduceAssistantMessageFrames(completeFrames)?.content[0], {
      type: "toolCall",
      id: "final-id",
      name: "write_file",
      arguments: { path: "final.md", lines: [3] },
      thoughtSignature: "thought",
      namespace: "files",
    });
  });

  void test("treats end signature metadata, including absence, as authoritative", () => {
    const frames: AssistantMessageFrame[] = [
      { type: "start", partial: seed() },
      {
        type: "text_start",
        contentIndex: 0,
        content: { type: "text", text: "", textSignature: "stale-text" },
      },
      { type: "text_end", contentIndex: 0, content: "" },
      {
        type: "thinking_start",
        contentIndex: 1,
        content: {
          type: "thinking",
          thinking: "",
          thinkingSignature: "stale-thinking",
          redacted: true,
        },
      },
      {
        type: "thinking_end",
        contentIndex: 1,
        content: "",
        thinkingSignature: "",
        redacted: false,
      },
      {
        type: "toolcall_start",
        contentIndex: 2,
        toolCall: {
          type: "toolCall",
          id: "call",
          name: "read",
          arguments: {},
          thoughtSignature: "stale-tool",
          namespace: "stale-namespace",
        },
      },
      { type: "toolcall_end", contentIndex: 2, id: "call", name: "read", arguments: {} },
    ];

    assert.deepEqual(reduceAssistantMessageFrames(frames)?.content, [
      { type: "text", text: "" },
      { type: "thinking", thinking: "", thinkingSignature: "", redacted: false },
      { type: "toolCall", id: "call", name: "read", arguments: {} },
    ]);
  });

  void test("stores authoritative final arguments in toolcall_end frames", () => {
    const partial = seed();
    const toolCall = {
      type: "toolCall" as const,
      id: "call-1",
      name: "read",
      arguments: { path: "README.md" },
      thoughtSignature: "thought",
      namespace: "files",
    };
    partial.content.push(toolCall);

    const end = frame({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
    assert.deepEqual(end, {
      type: "toolcall_end",
      contentIndex: 0,
      id: "call-1",
      name: "read",
      arguments: { path: "README.md" },
      thoughtSignature: "thought",
      namespace: "files",
    });
  });

  void test("whitelists public block fields from provider-shaped partials", () => {
    const partial = seed();
    const text = { type: "text" as const, text: "visible", textSignature: "text-sig", index: 4 };
    const thinking = {
      type: "thinking" as const,
      thinking: "reasoning",
      thinkingSignature: "thinking-sig",
      redacted: false,
      index: 5,
    };
    const toolCall = {
      type: "toolCall" as const,
      id: "call",
      name: "run",
      arguments: { value: 1 },
      thoughtSignature: "tool-sig",
      namespace: "tools",
      partialJson: '{"value":',
      streamIndex: 6,
    };
    partial.content.push(text, thinking, toolCall);
    const partialWithScratch = partial as AssistantMessage & { outputIndex?: number };
    partialWithScratch.outputIndex = 3;

    const start = frame({ type: "start", partial });
    const textStart = frame({ type: "text_start", contentIndex: 0, partial });
    const thinkingStart = frame({ type: "thinking_start", contentIndex: 1, partial });
    const toolStart = frame({ type: "toolcall_start", contentIndex: 2, partial });

    assert.deepEqual(start.type === "start" && start.partial.content, [
      { type: "text", text: "visible", textSignature: "text-sig" },
      {
        type: "thinking",
        thinking: "reasoning",
        thinkingSignature: "thinking-sig",
        redacted: false,
      },
      {
        type: "toolCall",
        id: "call",
        name: "run",
        arguments: { value: 1 },
        thoughtSignature: "tool-sig",
        namespace: "tools",
      },
    ]);
    assert.equal(hasPath(start, "partial.outputIndex"), false);
    assert.equal(hasPath(textStart, "content.index"), false);
    assert.equal(hasPath(thinkingStart, "content.index"), false);
    assert.equal(hasPath(toolStart, "toolCall.partialJson"), false);
    assert.equal(hasPath(toolStart, "toolCall.streamIndex"), false);
  });

  void test("supports interleaved streams by contentIndex", () => {
    const frames: AssistantMessageFrame[] = [
      { type: "start", partial: seed() },
      { type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
      {
        type: "toolcall_start",
        contentIndex: 1,
        toolCall: { type: "toolCall", id: "call", name: "lookup", arguments: {} },
      },
      { type: "thinking_start", contentIndex: 2, content: { type: "thinking", thinking: "" } },
      { type: "text_delta", contentIndex: 0, delta: "answer" },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"query":"pi"}' },
      { type: "thinking_delta", contentIndex: 2, delta: "check" },
      {
        type: "toolcall_end",
        contentIndex: 1,
        id: "call",
        name: "lookup",
        arguments: { query: "pi" },
      },
      { type: "text_end", contentIndex: 0, content: "answer" },
      { type: "thinking_end", contentIndex: 2, content: "check" },
    ];

    assert.deepEqual(reduceAssistantMessageFrames(frames)?.content, [
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call", name: "lookup", arguments: { query: "pi" } },
      { type: "thinking", thinking: "check" },
    ]);
  });

  void test("snapshots mutable event data and keeps reduction pure", () => {
    const partial = seed();
    partial.diagnostics = [{ type: "test", timestamp: 2, details: { value: "original" } }];
    const start = frame({ type: "start", partial });
    partial.diagnostics[0]!.details!.value = "mutated";
    partial.usage.cost.total = 99;

    partial.content.push({
      type: "toolCall",
      id: "call",
      name: "run",
      arguments: { nested: { value: "original" } },
    });
    const toolStart = frame({ type: "toolcall_start", contentIndex: 0, partial });
    const sourceTool = partial.content[0];
    if (sourceTool?.type !== "toolCall") throw new Error("Expected source tool call");
    (sourceTool.arguments.nested as Record<string, unknown>).value = "mutated";

    const reduced = reduceAssistantMessageFrames([start, toolStart]);
    assert.equal(reduced?.diagnostics?.[0]?.details?.value, "original");
    assert.equal(reduced?.usage.cost.total, 0);
    assert.equal(reduced?.content[0]?.type, "toolCall");
    assert.deepEqual(
      reduced?.content[0]?.type === "toolCall" ? reduced.content[0].arguments : undefined,
      { nested: { value: "original" } },
    );

    if (reduced?.content[0]?.type !== "toolCall") throw new Error("Expected reduced tool call");
    reduced.content[0].arguments.nested = "changed-output";
    assert.deepEqual(toolStart.type === "toolcall_start" && toolStart.toolCall.arguments.nested, {
      value: "original",
    });
  });

  void test("omits terminal events because settlement is separate", () => {
    const message = seed();
    message.stopReason = "stop";
    assert.equal(
      assistantMessageEventToFrame({ type: "done", reason: "stop", message }),
      undefined,
    );
    message.stopReason = "error";
    message.errorMessage = "failed";
    assert.equal(
      assistantMessageEventToFrame({ type: "error", reason: "error", error: message }),
      undefined,
    );
  });

  void test("returns undefined when there is no start frame", () => {
    assert.equal(reduceAssistantMessageFrames([]), undefined);
    assert.equal(
      reduceAssistantMessageFrames([{ type: "text_delta", contentIndex: 0, delta: "x" }]),
      undefined,
    );
  });

  void test("rejects frames before start, wrong block kinds, duplicate ends, and index gaps", () => {
    assert.throws(
      () =>
        reduceAssistantMessageFrames([
          { type: "text_delta", contentIndex: 0, delta: "x" },
          { type: "start", partial: seed() },
        ]),
      /before the start frame/,
    );
    assert.throws(
      () =>
        reduceAssistantMessageFrames([
          { type: "start", partial: seed() },
          {
            type: "toolcall_start",
            contentIndex: 0,
            toolCall: { type: "toolCall", id: "call", name: "run", arguments: {} },
          },
          { type: "text_delta", contentIndex: 0, delta: "wrong" },
        ]),
      /expected text block/,
    );
    assert.throws(
      () =>
        reduceAssistantMessageFrames([
          { type: "start", partial: seed() },
          { type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
          { type: "text_end", contentIndex: 0, content: "" },
          { type: "text_end", contentIndex: 0, content: "" },
        ]),
      /follows the end/,
    );
    assert.throws(
      () =>
        reduceAssistantMessageFrames([
          { type: "start", partial: seed() },
          { type: "text_start", contentIndex: 1, content: { type: "text", text: "" } },
        ]),
      /would leave a gap/,
    );
  });

  void test("rejects conversion events whose contentIndex points to the wrong block kind", () => {
    const partial = seed();
    partial.content.push({ type: "thinking", thinking: "" });
    assert.throws(
      () => assistantMessageEventToFrame({ type: "text_start", contentIndex: 0, partial }),
      /text_start event points to thinking block/,
    );
  });
});
