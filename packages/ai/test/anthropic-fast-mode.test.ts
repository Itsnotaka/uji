import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

function anthropicCatalogModel(id: string) {
  return Object.values(ANTHROPIC_MODELS).find((model) => model.id === id);
}

function fastAnthropicModelIds(): string[] {
  return Object.values(ANTHROPIC_MODELS)
    .filter((model) => model.provider === "anthropic" && model.modes?.includes("fast") === true)
    .map((model) => model.id)
    .sort();
}

const FAST_MODE_BETA = "fast-mode-2026-02-01";

const context: Context = {
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
};

function createModel(
  id: string,
  provider: Model<"anthropic-messages">["provider"] = "anthropic",
): Model<"anthropic-messages"> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://api.anthropic.test",
    reasoning: true,
    modes: anthropicCatalogModel(id)?.modes,
    input: ["text"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 8_192,
    headers: { "anthropic-beta": "model-beta" },
    compat: { forceAdaptiveThinking: true },
  };
}

interface CapturedAnthropicRequestBody {
  speed?: "fast" | "standard";
}

interface CapturedRequest {
  body?: CapturedAnthropicRequestBody;
  headers?: Headers;
}

function parseRequestBody(body: string): CapturedAnthropicRequestBody {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Expected a JSON object request body");
  }
  if (!("speed" in parsed)) return {};
  if (parsed.speed !== "fast" && parsed.speed !== "standard") {
    throw new Error("Expected a valid Anthropic request speed");
  }
  return { speed: parsed.speed };
}

function createSseResponse(model: string, speed: "fast" | "standard" | undefined): Response {
  const events = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_fast_mode",
          model,
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
            ...(speed === undefined ? {} : { speed }),
          },
        },
      },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_details: null },
        usage: {
          input_tokens: null,
          output_tokens: 1_000_000,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ];
  const body = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function runRequest(
  model: Model<"anthropic-messages">,
  options: SimpleStreamOptions,
  responseSpeed: "fast" | "standard" | undefined = "fast",
): Promise<{ captured: CapturedRequest; message: AssistantMessage }> {
  const captured: CapturedRequest = {};
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
    captured.body = parseRequestBody(init.body);
    captured.headers = new Headers(init.headers);
    return createSseResponse(model.id, responseSpeed);
  };
  const message = await streamAnthropic(model, context, {
    apiKey: "sk-ant-test",
    cacheRetention: "none",
    fetch,
    ...options,
  }).result();
  return { captured, message };
}

void describe("Anthropic fast mode", () => {
  void test("maps fast mode for every first-party catalog model that advertises it", async () => {
    const modelIds = fastAnthropicModelIds();
    assert.ok(modelIds.length > 0);
    for (const modelId of modelIds) {
      const { captured, message } = await runRequest(createModel(modelId), {
        fast: true,
        headers: { "Anthropic-Beta": "request-beta" },
      });

      assert.equal(captured.body?.speed, "fast");
      assert.equal(
        captured.headers?.get("anthropic-beta"),
        `model-beta,request-beta,${FAST_MODE_BETA}`,
      );
      assert.equal(message.stopReason, "stop");
      assert.equal(message.usage.cost.total, 60);
    }
  });

  void test("prices from the response speed instead of the request", async () => {
    const { message } = await runRequest(createModel("claude-opus-5"), { fast: true }, "standard");

    assert.equal(message.stopReason, "stop");
    assert.equal(message.usage.cost.total, 30);
  });

  void test("rejects unsupported and Anthropic-compatible models before sending", async () => {
    for (const model of [
      createModel("claude-opus-4-7"),
      createModel("claude-opus-5", "anthropic-compatible-test"),
    ]) {
      let fetchCalled = false;
      const message = await streamAnthropic(model, context, {
        apiKey: "sk-ant-test",
        fast: true,
        fetch: async () => {
          fetchCalled = true;
          throw new Error("Unexpected request");
        },
      }).result();

      assert.equal(fetchCalled, false);
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage ?? "", /not available/);
    }
  });
});
