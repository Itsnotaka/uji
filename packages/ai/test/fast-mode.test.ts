/** `fast` is the user-facing name; OpenAI receives its existing priority tier. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { streamSimple as streamCodex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAI } from "../src/api/openai-responses.ts";
import { OPENAI_CODEX_MODELS } from "../src/providers/openai-codex.models.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";
import type { Context, SimpleStreamOptions } from "../src/types.ts";

const context: Context = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

const codexModel = OPENAI_CODEX_MODELS["gpt-5.4"];
const openaiModel = OPENAI_MODELS["gpt-5.4"];

const codexToken = `h.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }),
).toString("base64")}.s`;

interface CapturedBody {
  service_tier?: unknown;
}

function isCapturedBody(value: unknown): value is CapturedBody {
  return typeof value === "object" && value !== null;
}

function capture(): { seen: { body?: unknown }; options: SimpleStreamOptions } {
  const seen: { body?: unknown } = {};
  return {
    seen,
    options: {
      maxRetries: 0,
      fetch: async () => {
        throw new Error("offline");
      },
      onPayload: (payload) => {
        seen.body = payload;
        return undefined;
      },
    },
  };
}

void describe("OpenAI fast mode", () => {
  void test("maps fast to the priority tier for OpenAI and Codex", async () => {
    const codex = capture();
    await streamCodex(codexModel, context, {
      ...codex.options,
      apiKey: codexToken,
      fast: true,
      transport: "sse",
    }).result();
    assert.ok(isCapturedBody(codex.seen.body));
    assert.equal(codex.seen.body.service_tier, "priority");

    const openai = capture();
    await streamOpenAI(openaiModel, context, {
      ...openai.options,
      apiKey: "sk-test",
      fast: true,
    }).result();
    assert.ok(isCapturedBody(openai.seen.body));
    assert.equal(openai.seen.body.service_tier, "priority");
  });
});
