import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anthropicProvider } from "../src/providers/anthropic.ts";

void describe("generated model catalog", () => {
  void test("includes Claude Fable 5.1 with its direct Anthropic capabilities", () => {
    const model = anthropicProvider()
      .getModels()
      .find((candidate) => candidate.id === "claude-fable-5-1");

    assert.ok(model);
    assert.equal(model.api, "anthropic-messages");
    assert.equal(model.provider, "anthropic");
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.deepEqual(model.thinkingLevelMap, { off: null, xhigh: "xhigh", max: "max" });
    assert.equal(model.compat?.forceAdaptiveThinking, true);
    assert.equal(model.compat?.supportsStrictTools, true);
  });
});
