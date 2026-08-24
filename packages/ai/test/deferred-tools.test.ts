/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/deferred-tools.test.ts
 * Synced with pi 7ebf9087e.
 *
 * Uji divergence: only the estimate test is here. The payload-capture tests go
 * through the adapters (`streamSimple`, `convertMessages`) and belong with them.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, Tool, ToolResultMessage, UserMessage } from "@uji-ai/schema";
import { estimateContextTokens } from "../src/utils/estimate.ts";

function makeTool(name: string): Tool {
  return {
    name,
    description: `The ${name} tool`,
    parameters: Type.Object({ value: Type.String() }),
  };
}

function makeUserMessage(timestamp: number): UserMessage {
  return { role: "user", content: "Hello", timestamp };
}

function makeAssistantToolCall(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function makeToolResult(addedToolNames: string[]): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "base_tool",
    content: [{ type: "text", text: "done" }],
    addedToolNames,
    isError: false,
    timestamp: 3,
  };
}

void describe("deferred tools", () => {
  void test("counts definitions marked after the latest usage checkpoint", () => {
    const assistant: AssistantMessage = {
      ...makeAssistantToolCall(),
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 50,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    };
    const plain = estimateContextTokens({ messages: [assistant, makeUserMessage(4)], tools: [] });
    const lateTool = { ...makeTool("late_tool"), description: "x".repeat(4000) };
    const marked = estimateContextTokens({
      messages: [assistant, makeToolResult(["late_tool"])],
      tools: [lateTool],
    });

    assert.ok(marked.tokens > plain.tokens + 500);
    assert.ok(marked.trailingTokens > plain.trailingTokens + 500);
  });
});
