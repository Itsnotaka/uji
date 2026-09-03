import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Context, Model } from "../src/types.ts";
import {
  compactOpenAICodexContext,
  fetchOpenAICodexAccountLimits,
} from "../src/api/openai-codex-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";

function model(id = "gpt-5.4"): Model<"openai-codex-responses"> {
  return {
    id,
    name: id,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

function accessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

void describe("OpenAI Codex account limits and compaction", () => {
  void test("parses subscription windows from wham/usage", async () => {
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "account-1");
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 28,
              limit_window_seconds: 18_000,
              reset_at: 2_000_000_000,
            },
            secondary_window: {
              used_percent: 56,
              limit_window_seconds: 604_800,
              reset_at: 2_000_100_000,
            },
          },
        }),
      );
    };

    const limits = await fetchOpenAICodexAccountLimits(model(), {
      apiKey: accessToken("account-1"),
      fetch,
    });
    assert.equal(limits.plan, "plus");
    assert.deepEqual(
      limits.windows.map((window) => ({
        id: window.id,
        usedPercent: window.usedPercent,
        windowMinutes: window.windowMinutes,
      })),
      [
        { id: "five_hour", usedPercent: 28, windowMinutes: 300 },
        { id: "seven_day", usedPercent: 56, windowMinutes: 10_080 },
      ],
    );
  });

  void test("retries a missing native compact route three times before succeeding", async () => {
    const nativeItems = [{ type: "compaction", encrypted_content: "opaque" }];
    const context: Context = {
      messages: [{ role: "user", content: "old conversation", timestamp: 1 }],
    };
    let calls = 0;

    const compacted = await compactOpenAICodexContext(model(), context, {
      apiKey: accessToken("account-1"),
      fetch: async () => {
        calls += 1;
        return calls < 4
          ? new Response('{"detail":"Not Found"}', {
              status: 404,
              headers: { "retry-after-ms": "0" },
            })
          : new Response(JSON.stringify({ output: nativeItems }));
      },
    });

    assert.equal(calls, 4);
    assert.deepEqual(compacted.data, nativeItems);
  });

  void test("stops after the native compact retry budget is exhausted", async () => {
    const context: Context = {
      messages: [{ role: "user", content: "old conversation", timestamp: 1 }],
    };
    let calls = 0;

    await assert.rejects(
      compactOpenAICodexContext(model(), context, {
        apiKey: accessToken("account-1"),
        fetch: async () => {
          calls += 1;
          return new Response('{"detail":"Not Found"}', {
            status: 404,
            headers: { "retry-after-ms": "0" },
          });
        },
      }),
    );

    assert.equal(calls, 4);
  });

  void test("returns opaque compact output and replays it only to the matching target", async () => {
    const nativeItems = [{ type: "compaction", encrypted_content: "opaque" }];
    const context: Context = {
      systemPrompt: "agent",
      messages: [{ role: "user", content: "old conversation", timestamp: 1 }],
    };
    const compacted = await compactOpenAICodexContext(model(), context, {
      apiKey: accessToken("account-1"),
      fetch: async () => new Response(JSON.stringify({ output: nativeItems })),
    });
    assert.deepEqual(compacted.data, nativeItems);

    const checkpointContext: Context = {
      checkpoint: {
        type: "provider",
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.4",
        data: compacted.data,
      },
      messages: [],
    };
    assert.deepEqual(convertResponsesMessages(model(), checkpointContext, new Set()), nativeItems);
    const fallbackContext: Context = {
      messages: [{ role: "user", timestamp: 2, content: "portable fallback" }],
    };
    assert.deepEqual(convertResponsesMessages(model("gpt-5.5"), fallbackContext, new Set()), [
      {
        role: "user",
        content: [{ type: "input_text", text: "portable fallback" }],
      },
    ]);
  });
});
