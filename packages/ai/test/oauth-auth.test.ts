/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/oauth-auth.test.ts
 * Synced with pi 7ebf9087e.
 * Uji keeps only the anthropic and openai-codex flows; the github-copilot,
 * kimi, openrouter, and xai cases are dropped with their providers. The
 * Models.getAuth cases run through resolveProviderAuth + lazyOAuth directly.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { defaultProviderAuthContext } from "../src/auth/context.ts";
import { lazyOAuth } from "../src/auth/helpers.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { loadAnthropicOAuth } from "../src/auth/oauth/load.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";

const neverAbortedSignal = new AbortController().signal;
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64");
  return `${header}.${payload}.signature`;
}

void describe("OAuthAuth adapters", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  void test("identifies subscription-backed OAuth flows as subscriptions", () => {
    for (const oauth of [anthropicOAuth, openaiCodexOAuth]) {
      assert.equal(oauth.isSubscription, true);
    }
  });

  void test("anthropic toAuth derives the api key from the access token", async () => {
    const auth = await anthropicOAuth.toAuth({
      type: "oauth",
      access: "token",
      refresh: "r",
      expires: 0,
    });
    assert.deepEqual(auth, { apiKey: "token" });
  });

  void test("openai-codex toAuth derives the api key and account header from the access token", async () => {
    // Uji divergence: pi returns only { apiKey }; Uji's toAuth also carries
    // the chatgpt-account-id header for the legacy Responses adapter.
    const access = createAccessToken("acct-1");
    const auth = await openaiCodexOAuth.toAuth({ type: "oauth", access, refresh: "r", expires: 0 });
    assert.deepEqual(auth, { apiKey: access, headers: { "chatgpt-account-id": "acct-1" } });
  });

  void test("anthropic refresh exchanges the refresh token and returns a typed credential", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      })) as typeof fetch;

    const refreshed = await anthropicOAuth.refresh(
      { type: "oauth", access: "old", refresh: "old-r", expires: 0 },
      neverAbortedSignal,
    );
    assert.equal(refreshed.type, "oauth");
    assert.equal(refreshed.access, "new-access");
    assert.equal(refreshed.refresh, "new-refresh");
    assert.ok(refreshed.expires > Date.now());
  });
});

void describe("OAuth through resolveProviderAuth (lazy load chain)", () => {
  void test("resolves stored anthropic oauth credentials via the lazy flow import", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "oauth",
      access: "oauth-access-token",
      refresh: "r",
      // Keep this beyond the refresh window.
      expires: Date.now() + 10 * 60_000,
    }));
    const provider = {
      id: "anthropic",
      auth: {
        oauth: lazyOAuth({
          name: "Anthropic (Claude Pro/Max)",
          isSubscription: true,
          load: loadAnthropicOAuth,
        }),
      },
    };

    const result = await resolveProviderAuth(provider, credentials, defaultProviderAuthContext());
    assert.equal(result?.auth.apiKey, "oauth-access-token");
    assert.equal(result?.source, "OAuth");
  });
});
