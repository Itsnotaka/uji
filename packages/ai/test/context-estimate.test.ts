/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/context-estimate.test.ts
 * Synced with pi 7ebf9087e.
 *
 * June divergence: the `buildBaseOptions(model, context).maxTokens` assertion is
 * omitted; `api/simple-options.ts` is ported with the adapters, not the utils.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, Context, Usage } from "@june/schema";
import { estimateContextTokens } from "../src/utils/estimate.ts";

function createUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "kept" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: createUsage(totalTokens),
    stopReason: "stop",
    timestamp,
  };
}

void describe("context token estimation", () => {
  void test("ignores stale assistant usage after a newer message is inserted before it", () => {
    const context: Context = {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "summary", timestamp: 200 },
        createAssistant(100, 9_500),
        { role: "user", content: "x".repeat(4_000), timestamp: 300 },
      ],
    };

    assert.deepEqual(estimateContextTokens(context), {
      tokens: 1_005,
      usageTokens: 0,
      trailingTokens: 1_005,
      lastUsageIndex: null,
    });
  });

  void test("uses assistant usage again after a response to the inserted context", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "summary", timestamp: 200 },
        createAssistant(100, 9_500),
        { role: "user", content: "new prompt", timestamp: 300 },
        createAssistant(400, 2_000),
        { role: "user", content: "tail", timestamp: 500 },
      ],
    };

    assert.deepEqual(estimateContextTokens(context), {
      tokens: 2_001,
      usageTokens: 2_000,
      trailingTokens: 1,
      lastUsageIndex: 3,
    });
  });
});
