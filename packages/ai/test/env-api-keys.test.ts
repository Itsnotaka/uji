/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/env-api-keys.test.ts
 * Synced with pi 7ebf9087e.
 *
 * June divergence: the GitHub Copilot and ZAI cases are dropped with those providers.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";

const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalAnthropicOauthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore("ANTHROPIC_AUTH_TOKEN", originalAnthropicAuthToken);
  restore("ANTHROPIC_OAUTH_TOKEN", originalAnthropicOauthToken);
  restore("ANTHROPIC_API_KEY", originalAnthropicApiKey);
});

void describe("environment API keys", () => {
  void test("reports ANTHROPIC_AUTH_TOKEN but preserves OAuth token API key lookup", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
    process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
    process.env.ANTHROPIC_API_KEY = "api-key";

    assert.deepEqual(findEnvKeys("anthropic"), [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    assert.equal(getEnvApiKey("anthropic"), "oauth-token");
  });

  void test("does not return ANTHROPIC_AUTH_TOKEN as an API key", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-token";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;

    assert.deepEqual(findEnvKeys("anthropic"), ["ANTHROPIC_AUTH_TOKEN"]);
    assert.equal(getEnvApiKey("anthropic"), undefined);
  });

  void test("preserves ANTHROPIC_OAUTH_TOKEN as an API key", () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
    delete process.env.ANTHROPIC_API_KEY;

    assert.deepEqual(findEnvKeys("anthropic"), ["ANTHROPIC_OAUTH_TOKEN"]);
    assert.equal(getEnvApiKey("anthropic"), "oauth-token");
  });

  void test("falls back to ANTHROPIC_API_KEY for API key lookup", () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "api-key";

    assert.equal(getEnvApiKey("anthropic"), "api-key");
  });

  void test("resolves OpenAI credentials from OPENAI_API_KEY and nothing for OAuth-only providers", () => {
    const original = process.env.OPENAI_API_KEY;
    try {
      assert.deepEqual(findEnvKeys("openai", { OPENAI_API_KEY: "openai-key" }), ["OPENAI_API_KEY"]);
      assert.equal(getEnvApiKey("openai", { OPENAI_API_KEY: "openai-key" }), "openai-key");
      assert.equal(findEnvKeys("openai-codex"), undefined);
    } finally {
      restore("OPENAI_API_KEY", original);
    }
  });
});
