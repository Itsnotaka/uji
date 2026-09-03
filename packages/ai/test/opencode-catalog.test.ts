import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseOpenCodeCatalog } from "../src/providers/opencode-catalog.ts";

function catalog(
  models: Readonly<Record<string, Record<string, unknown>>>,
  provider: Readonly<Record<string, unknown>> = {},
): unknown {
  return { opencode: { npm: "@ai-sdk/anthropic", models, ...provider } };
}

function model(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { id: "claude", tool_call: true, ...overrides };
}

describe("parseOpenCodeCatalog", () => {
  test("parses a minimal model", () => {
    const models = parseOpenCodeCatalog(catalog({ claude: model() }), "opencode");
    assert.equal(models.length, 1);
    assert.deepEqual(models[0], {
      id: "claude",
      name: "claude",
      provider: "opencode",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 4096,
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
  });

  test("drops deprecated models", () => {
    assert.throws(
      () => parseOpenCodeCatalog(catalog({ claude: model({ status: "deprecated" }) }), "opencode"),
      /no compatible tool models/,
    );
  });

  test("drops models without tool calling", () => {
    assert.throws(
      () => parseOpenCodeCatalog(catalog({ claude: model({ tool_call: false }) }), "opencode"),
      /no compatible tool models/,
    );
  });

  test("drops models whose id disagrees with the catalog key", () => {
    assert.throws(
      () => parseOpenCodeCatalog(catalog({ claude: model({ id: "other" }) }), "opencode"),
      /no compatible tool models/,
    );
  });

  test("drops models with an unrecognised npm package", () => {
    assert.throws(
      () =>
        parseOpenCodeCatalog(catalog({ claude: model() }, { npm: "@ai-sdk/unknown" }), "opencode"),
      /no compatible tool models/,
    );
  });

  test("drops google models on opencode-go", () => {
    const value = {
      "opencode-go": { npm: "@ai-sdk/google", models: { gemini: model({ id: "gemini" }) } },
    };
    assert.throws(() => parseOpenCodeCatalog(value, "opencode-go"), /no compatible tool models/);
  });

  test("keeps google models on opencode", () => {
    const models = parseOpenCodeCatalog(
      catalog({ gemini: model({ id: "gemini" }) }, { npm: "@ai-sdk/google" }),
      "opencode",
    );
    assert.equal(models.length, 1);
    assert.equal(models[0]?.api, "google-generative-ai");
    assert.equal(models[0]?.baseUrl, "https://opencode.ai/zen/v1");
  });

  test("falls back to 4096 when limit is missing or not positive", () => {
    const models = parseOpenCodeCatalog(
      catalog({
        claude: model({ limit: { context: 0, output: 8192 } }),
        opus: model({ id: "opus" }),
      }),
      "opencode",
    );
    const claude = models.find((entry) => entry.id === "claude");
    const opus = models.find((entry) => entry.id === "opus");
    assert.equal(claude?.contextWindow, 4096);
    assert.equal(claude?.maxTokens, 8192);
    assert.equal(opus?.contextWindow, 4096);
    assert.equal(opus?.maxTokens, 4096);
  });

  test("falls back to the id when name is empty", () => {
    const models = parseOpenCodeCatalog(catalog({ claude: model({ name: "" }) }), "opencode");
    assert.equal(models[0]?.name, "claude");
  });

  test("model-level npm overrides provider-level npm", () => {
    const models = parseOpenCodeCatalog(
      catalog({ gpt: model({ id: "gpt", provider: { npm: "@ai-sdk/openai" } }) }),
      "opencode",
    );
    assert.equal(models[0]?.api, "openai-responses");
  });

  test("an empty model-level npm falls through to the provider-level npm", () => {
    const models = parseOpenCodeCatalog(
      catalog({ claude: model({ provider: { npm: "" } }) }),
      "opencode",
    );
    assert.equal(models[0]?.api, "anthropic-messages");
  });

  test("reads image input from modalities", () => {
    const models = parseOpenCodeCatalog(
      catalog({ claude: model({ modalities: { input: ["text", "image"] } }) }),
      "opencode",
    );
    assert.deepEqual(models[0]?.input, ["text", "image"]);
  });

  test("skips a malformed cost tier but keeps the model and the other tiers", () => {
    const models = parseOpenCodeCatalog(
      catalog({
        claude: model({
          cost: {
            input: 3,
            output: 15,
            tiers: [
              { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5 },
              { tier: { type: "context" } },
              { tier: { type: "output", size: 200_000 } },
              "nonsense",
            ],
          },
        }),
      }),
      "opencode",
    );
    assert.deepEqual(models[0]?.cost, {
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5, cacheRead: 0, cacheWrite: 0 }],
    });
  });

  test("omits tiers when no tier parses", () => {
    const models = parseOpenCodeCatalog(
      catalog({ claude: model({ cost: { input: 3, tiers: ["nonsense"] } }) }),
      "opencode",
    );
    assert.deepEqual(models[0]?.cost, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("skips a malformed reasoning option but keeps the model", () => {
    const models = parseOpenCodeCatalog(
      catalog({
        claude: model({
          reasoning: true,
          reasoning_options: ["nonsense", { type: "toggle" }, { type: "effort", values: ["low"] }],
        }),
      }),
      "opencode",
    );
    assert.equal(models[0]?.reasoning, true);
    assert.equal(models[0]?.thinkingLevelMap?.low, "low");
    assert.equal(models[0]?.thinkingLevelMap?.high, null);
  });

  test("leaves thinkingLevelMap unset when no effort options are listed", () => {
    const models = parseOpenCodeCatalog(
      catalog({ claude: model({ reasoning_options: [{ type: "toggle" }] }) }),
      "opencode",
    );
    assert.equal(models[0]?.thinkingLevelMap, undefined);
  });

  test("keeps a model whose optional fields are wrong-typed", () => {
    const models = parseOpenCodeCatalog(
      catalog({
        claude: model({
          name: 42,
          status: null,
          reasoning: "true",
          provider: "anthropic",
          modalities: [],
          limit: null,
          cost: null,
          reasoning_options: {},
        }),
      }),
      "opencode",
    );
    assert.deepEqual(models[0], {
      id: "claude",
      name: "claude",
      provider: "opencode",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 4096,
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
  });

  test("falls back field by field inside limit and cost", () => {
    const models = parseOpenCodeCatalog(
      catalog({
        claude: model({
          limit: { context: "200000", output: 8192 },
          cost: { input: "3", output: 15 },
        }),
      }),
      "opencode",
    );
    assert.equal(models[0]?.contextWindow, 4096);
    assert.equal(models[0]?.maxTokens, 8192);
    assert.deepEqual(models[0]?.cost, { input: 0, output: 15, cacheRead: 0, cacheWrite: 0 });
  });

  test("keeps a cost tier whose price is wrong-typed", () => {
    const models = parseOpenCodeCatalog(
      catalog({
        claude: model({
          cost: { input: 3, tiers: [{ tier: { type: "context", size: 200_000 }, input: "6" }] },
        }),
      }),
      "opencode",
    );
    assert.deepEqual(models[0]?.cost.tiers, [
      { inputTokensAbove: 200_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  test("keeps the string efforts of a reasoning option that lists a non-string", () => {
    const models = parseOpenCodeCatalog(
      catalog({ claude: model({ reasoning_options: [{ type: "effort", values: ["low", 7] }] }) }),
      "opencode",
    );
    assert.equal(models[0]?.thinkingLevelMap?.low, "low");
  });

  test("parses one provider when the other subtree is malformed", () => {
    const value = {
      opencode: { npm: "@ai-sdk/anthropic", models: { claude: model() } },
      "opencode-go": { npm: 3, models: [] },
    };
    const models = parseOpenCodeCatalog(value, "opencode");
    assert.equal(models.length, 1);
  });

  test("throws when the provider is missing", () => {
    assert.throws(
      () => parseOpenCodeCatalog({ anthropic: {} }, "opencode"),
      /OpenCode catalog does not contain provider opencode/,
    );
  });

  test("throws when the provider has no models", () => {
    assert.throws(
      () => parseOpenCodeCatalog({ opencode: { npm: "@ai-sdk/anthropic" } }, "opencode"),
      /OpenCode catalog has no models for provider opencode/,
    );
  });
});
