import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  anthropicProvider,
  openaiCodexProvider,
  openaiProvider,
  promptCacheMinimumTtlMs,
  resolveCacheRetention,
} from "../src/index.ts";

void describe("prompt cache policy", () => {
  void test("resolves explicit and provider-scoped retention", () => {
    assert.equal(resolveCacheRetention("none", { PI_CACHE_RETENTION: "long" }), "none");
    assert.equal(resolveCacheRetention(undefined, { PI_CACHE_RETENTION: "long" }), "long");
    assert.equal(resolveCacheRetention(undefined, { PI_CACHE_RETENTION: "short" }), "short");
  });

  void test("publishes the built-in providers' minimum warm windows", () => {
    const anthropic = anthropicProvider().promptCache;
    const openai = openaiProvider().promptCache;
    const codex = openaiCodexProvider().promptCache;

    assert.equal(promptCacheMinimumTtlMs(anthropic, "short"), 5 * 60_000);
    assert.equal(promptCacheMinimumTtlMs(anthropic, "long"), 60 * 60_000);
    assert.equal(promptCacheMinimumTtlMs(openai, "short"), 5 * 60_000);
    assert.equal(promptCacheMinimumTtlMs(openai, "long"), 24 * 60 * 60_000);
    assert.equal(promptCacheMinimumTtlMs(codex, "long"), 5 * 60_000);
    assert.equal(promptCacheMinimumTtlMs(openai, "none"), undefined);
    assert.equal(promptCacheMinimumTtlMs(undefined, "short"), undefined);
  });
});
