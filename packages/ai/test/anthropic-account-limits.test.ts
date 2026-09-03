import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchAnthropicAccountLimits } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";

const NOW = 2_000_000_000_000;

function model(): Model<"anthropic-messages"> {
  return {
    id: "claude-test",
    name: "Claude Test",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  };
}

void describe("Anthropic account limits", () => {
  void test("fetches and normalizes Claude Code subscription windows", async () => {
    const resetsAt = new Date(NOW).toISOString();
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer sk-ant-oat-test");
      assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
      assert.match(headers.get("user-agent") ?? "", /^claude-cli\//u);
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 28, resets_at: resetsAt },
          seven_day: { utilization: 56, resets_at: resetsAt },
          seven_day_sonnet: { utilization: 91, resets_at: resetsAt },
          seven_day_opus: { utilization: null, resets_at: null },
        }),
      );
    };

    const limits = await fetchAnthropicAccountLimits(model(), {
      apiKey: "sk-ant-oat-test",
      fetch,
    });
    assert.equal(limits.providerId, "anthropic");
    assert.deepEqual(limits.windows, [
      {
        id: "five_hour",
        usedPercent: 28,
        windowMinutes: 300,
        resetsAt: NOW,
      },
      {
        id: "seven_day",
        usedPercent: 56,
        windowMinutes: 10_080,
        resetsAt: NOW,
      },
      {
        id: "seven_day_sonnet",
        usedPercent: 91,
        windowMinutes: 10_080,
        resetsAt: NOW,
      },
    ]);
  });

  void test("rejects API keys before calling the subscription endpoint", async () => {
    let called = false;
    await assert.rejects(
      fetchAnthropicAccountLimits(model(), {
        apiKey: "sk-ant-api-test",
        fetch: async () => {
          called = true;
          return new Response();
        },
      }),
      /requires Anthropic OAuth/u,
    );
    assert.equal(called, false);
  });
});
