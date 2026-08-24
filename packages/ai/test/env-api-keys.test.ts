/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/env-api-keys.test.ts
 * Synced with pi 7ebf9087e.
 *
 * Uji divergence: the GitHub Copilot and ZAI cases are dropped with those providers.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_AUTH_TOKEN_ENV,
  ANTHROPIC_ENV_KEYS,
  ANTHROPIC_OAUTH_TOKEN_ENV,
  findEnvKeys,
  getEnvApiKey,
} from "../src/env-api-keys.ts";

const originalAnthropicEnv = new Map(
  ANTHROPIC_ENV_KEYS.map((name) => [name, process.env[name]] as const),
);

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of ANTHROPIC_ENV_KEYS) {
    restore(name, originalAnthropicEnv.get(name));
  }
});

void describe("environment API keys", () => {
  void test("reports ANTHROPIC_AUTH_TOKEN but preserves OAuth token API key lookup", () => {
    process.env[ANTHROPIC_AUTH_TOKEN_ENV] = "auth-token";
    process.env[ANTHROPIC_OAUTH_TOKEN_ENV] = "oauth-token";
    process.env[ANTHROPIC_API_KEY_ENV] = "api-key";

    assert.deepEqual(findEnvKeys("anthropic"), [...ANTHROPIC_ENV_KEYS]);
    assert.equal(getEnvApiKey("anthropic"), "oauth-token");
  });

  void test("does not return ANTHROPIC_AUTH_TOKEN as an API key", () => {
    process.env[ANTHROPIC_AUTH_TOKEN_ENV] = "auth-token";
    delete process.env[ANTHROPIC_OAUTH_TOKEN_ENV];
    delete process.env[ANTHROPIC_API_KEY_ENV];

    assert.deepEqual(findEnvKeys("anthropic"), [ANTHROPIC_AUTH_TOKEN_ENV]);
    assert.equal(getEnvApiKey("anthropic"), undefined);
  });

  void test("preserves ANTHROPIC_OAUTH_TOKEN as an API key", () => {
    delete process.env[ANTHROPIC_AUTH_TOKEN_ENV];
    process.env[ANTHROPIC_OAUTH_TOKEN_ENV] = "oauth-token";
    delete process.env[ANTHROPIC_API_KEY_ENV];

    assert.deepEqual(findEnvKeys("anthropic"), [ANTHROPIC_OAUTH_TOKEN_ENV]);
    assert.equal(getEnvApiKey("anthropic"), "oauth-token");
  });

  void test("falls back to ANTHROPIC_API_KEY for API key lookup", () => {
    delete process.env[ANTHROPIC_AUTH_TOKEN_ENV];
    delete process.env[ANTHROPIC_OAUTH_TOKEN_ENV];
    process.env[ANTHROPIC_API_KEY_ENV] = "api-key";

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
