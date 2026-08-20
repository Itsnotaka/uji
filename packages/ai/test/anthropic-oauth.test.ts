/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/anthropic-oauth.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";

const neverAbortedSignal = new AbortController().signal;
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function getUrl(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function getJsonBody(init?: RequestInit): Record<string, string> {
  if (typeof init?.body !== "string") {
    throw new Error(`Expected string request body, got ${typeof init?.body}`);
  }
  return JSON.parse(init.body) as Record<string, string>;
}

function stubFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>): {
  calls: number;
} {
  const state = { calls: 0 };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    state.calls++;
    return impl(input, init);
  }) as typeof fetch;
  return state;
}

void describe("Anthropic OAuth", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  void test("keeps the localhost redirect_uri for manual callback login", async () => {
    let authUrl = "";
    const fetchMock = stubFetch(async (input, init) => {
      assert.equal(getUrl(input), "https://platform.claude.com/v1/oauth/token");
      assert.equal(init?.method, "POST");
      const body = getJsonBody(init);
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.code, "manual-code");
      assert.equal(body.redirect_uri, "http://localhost:53692/callback");
      return jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      });
    });

    const credentials = await anthropicOAuth.login({
      signal: neverAbortedSignal,
      notify: (event) => {
        if (event.type === "auth_url") authUrl = event.url;
      },
      prompt: async (prompt) => {
        if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
        const url = new URL(authUrl);
        const state = url.searchParams.get("state");
        const redirectUri = url.searchParams.get("redirect_uri");
        if (!state || !redirectUri)
          throw new Error("Missing OAuth state or redirect_uri in auth URL");
        return `${redirectUri}?code=manual-code&state=${state}`;
      },
    });

    assert.equal(credentials.access, "access-token");
    assert.equal(credentials.refresh, "refresh-token");
    assert.equal(fetchMock.calls, 1);
  });

  void test("omits scope from refresh token requests", async () => {
    const fetchMock = stubFetch(async (input, init) => {
      assert.equal(getUrl(input), "https://platform.claude.com/v1/oauth/token");
      assert.equal(init?.method, "POST");
      const body = getJsonBody(init);
      assert.equal(body.grant_type, "refresh_token");
      assert.ok(body.client_id);
      assert.equal(body.refresh_token, "refresh-token");
      assert.ok(!("scope" in body));
      return jsonResponse({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      });
    });

    const credentials = await anthropicOAuth.refresh(
      {
        type: "oauth",
        access: "old-access-token",
        refresh: "refresh-token",
        expires: 0,
      },
      neverAbortedSignal,
    );

    assert.equal(credentials.access, "new-access-token");
    assert.equal(credentials.refresh, "new-refresh-token");
    assert.equal(fetchMock.calls, 1);
  });

  void test("anthropicOAuth.login resolves through the manual_code prompt and aborts it after settling", async () => {
    stubFetch(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/oauth/token")) {
        return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const events: AuthEvent[] = [];
    const prompts: AuthPrompt[] = [];
    let manualSignal: AbortSignal | undefined;

    const credential = await anthropicOAuth.login({
      signal: neverAbortedSignal,
      notify: (event) => events.push(event),
      prompt: async (prompt) => {
        prompts.push(prompt);
        if (prompt.type === "manual_code") {
          manualSignal = prompt.signal;
          return "the-code";
        }
        throw new Error(`Unexpected prompt: ${prompt.type}`);
      },
    });

    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, "access");
    assert.ok(events.some((e) => e.type === "auth_url"));
    assert.ok(prompts.some((p) => p.type === "manual_code"));
    // the prompt's signal is aborted once login settles, so UIs can dismiss it
    assert.equal(manualSignal?.aborted, true);
  });
});
