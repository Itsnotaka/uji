/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/openai-codex-oauth.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";

const neverAbortedSignal = new AbortController().signal;
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString("base64");
  return `${header}.${payload}.signature`;
}

function deviceAuthPendingResponse(): Response {
  return jsonResponse(
    {
      error: {
        message: "Device authorization is pending. Please try again.",
        type: "invalid_request_error",
        param: null,
        code: "deviceauth_authorization_pending",
      },
    },
    403,
  );
}

type DeviceInfo = {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
};

function loginOpenAICodexDeviceCodeForTest(options: {
  onDeviceCode(info: DeviceInfo): void;
  signal?: AbortSignal;
}) {
  return openaiCodexOAuth.login({
    signal: options.signal ?? neverAbortedSignal,
    prompt: async (prompt) => {
      if (prompt.type !== "select") throw new Error(`Unexpected prompt: ${prompt.type}`);
      return "device_code";
    },
    notify: (event) => {
      if (event.type === "device_code") {
        const { type: _, ...info } = event;
        options.onDeviceCode(info);
      }
    },
  });
}

function stubFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof fetch;
}

function bodyText(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error(`Expected string or URLSearchParams body, got ${typeof body}`);
}

function headerValue(
  headers: ConstructorParameters<typeof Headers>[0] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers).get(name) ?? undefined;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await flush();
}

void describe("OpenAI Codex OAuth", () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
    globalThis.fetch = realFetch;
  });

  void test("logs in with the OpenAI Codex device code flow", async () => {
    const startTime = new Date("2026-05-20T00:00:00Z").getTime();
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: startTime });

    const accessToken = createAccessToken("account-123");
    const deviceInfos: DeviceInfo[] = [];
    const pollTimes: number[] = [];
    const pollResponses = [
      deviceAuthPendingResponse(),
      jsonResponse({
        authorization_code: "oauth-code",
        code_challenge: "device-code-challenge",
        code_verifier: "device-code-verifier",
      }),
    ];

    stubFetch(async (input, init) => {
      const url = getUrl(input);

      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        assert.equal(init?.method, "POST");
        assert.equal(headerValue(init?.headers, "Content-Type"), "application/json");
        assert.deepEqual(JSON.parse(bodyText(init)), {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        });
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: "5",
        });
      }

      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        pollTimes.push(Date.now());
        assert.equal(init?.method, "POST");
        assert.equal(headerValue(init?.headers, "Content-Type"), "application/json");
        assert.deepEqual(JSON.parse(bodyText(init)), {
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
        });
        const response = pollResponses.shift();
        if (!response) {
          throw new Error("Unexpected extra device auth poll");
        }
        return response;
      }

      if (url === "https://auth.openai.com/oauth/token") {
        assert.equal(init?.method, "POST");
        assert.equal(
          headerValue(init?.headers, "Content-Type"),
          "application/x-www-form-urlencoded",
        );
        const params = new URLSearchParams(bodyText(init));
        assert.equal(params.get("grant_type"), "authorization_code");
        assert.equal(params.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
        assert.equal(params.get("code"), "oauth-code");
        assert.equal(params.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
        assert.equal(params.get("code_verifier"), "device-code-verifier");
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
      onDeviceCode: (info) => deviceInfos.push(info),
    });

    for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
      await advance(0);
    }
    assert.deepEqual(deviceInfos, [
      {
        userCode: "ABCD-1234",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    ]);
    assert.deepEqual(pollTimes, [startTime]);

    await advance(4999);
    assert.deepEqual(pollTimes, [startTime]);

    await advance(1);
    const credentials = await credentialsPromise;
    assert.equal(credentials.access, accessToken);
    assert.equal(credentials.refresh, "refresh-token");
    assert.equal(credentials.expires, startTime + 5000 + 3600 * 1000);
    assert.equal(credentials["accountId"], "account-123");
    assert.deepEqual(pollTimes, [startTime, startTime + 5000]);
  });

  void test("offers browser login first and uses the selected OpenAI Codex device code flow", async () => {
    const accessToken = createAccessToken("account-456");
    const selectPrompts: Array<{
      message: string;
      options: readonly { id: string; label: string }[];
    }> = [];
    const deviceInfos: DeviceInfo[] = [];

    stubFetch(async (input, init) => {
      const url = getUrl(input);
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        assert.deepEqual(JSON.parse(bodyText(init)), {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        });
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "WXYZ-7890",
          interval: "5",
        });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        return jsonResponse({
          authorization_code: "oauth-code",
          code_challenge: "device-code-challenge",
          code_verifier: "device-code-verifier",
        });
      }
      if (url === "https://auth.openai.com/oauth/token") {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const credential = await openaiCodexOAuth.login({
      signal: neverAbortedSignal,
      prompt: async (prompt) => {
        if (prompt.type !== "select") throw new Error("Text prompt should not be used");
        selectPrompts.push(prompt);
        return "device_code";
      },
      notify: (event) => {
        if (event.type === "auth_url") throw new Error("Browser login should not start");
        if (event.type === "device_code") {
          const { type: _, ...info } = event;
          deviceInfos.push(info);
        }
      },
    });
    assert.equal(credential.type, "oauth");
    assert.equal(credential.access, accessToken);
    assert.equal(credential.refresh, "refresh-token");
    assert.equal(credential["accountId"], "account-456");

    assert.deepEqual(selectPrompts, [
      {
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "browser", label: "Browser login (default)" },
          { id: "device_code", label: "Device code login (headless)" },
        ],
      },
    ]);
    assert.deepEqual(deviceInfos, [
      {
        userCode: "WXYZ-7890",
        verificationUri: "https://auth.openai.com/codex/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    ]);
  });

  void test("cancels when OpenAI Codex login method selection is cancelled", async () => {
    await assert.rejects(
      openaiCodexOAuth.login({
        signal: neverAbortedSignal,
        prompt: async () => {
          throw new Error("Login cancelled");
        },
        notify: () => {},
      }),
      { message: "Login cancelled" },
    );
  });

  void test("cancels the OpenAI Codex device code flow while waiting", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const controller = new AbortController();
    const pollTimes: number[] = [];

    stubFetch(async (input, init) => {
      const url = getUrl(input);
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        assert.deepEqual(JSON.parse(bodyText(init)), {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        });
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: "5",
        });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        pollTimes.push(Date.now());
        return deviceAuthPendingResponse();
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
      onDeviceCode: () => {},
      signal: controller.signal,
    });
    const rejectionPromise = credentialsPromise.then(
      () => new Error("Expected login to fail"),
      (error: unknown) => error,
    );

    for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
      await advance(0);
    }
    assert.equal(pollTimes.length, 1);

    controller.abort();
    const rejection = await rejectionPromise;
    assert.ok(rejection instanceof Error);
    assert.equal(rejection.message, "Login cancelled");
  });

  void test("times out the OpenAI Codex device code flow after 15 minutes", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pollTimes: number[] = [];

    stubFetch(async (input, init) => {
      const url = getUrl(input);
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        assert.deepEqual(JSON.parse(bodyText(init)), {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        });
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: "60",
        });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        pollTimes.push(Date.now());
        return deviceAuthPendingResponse();
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
      onDeviceCode: () => {},
    });
    const rejectionPromise = credentialsPromise.then(
      () => new Error("Expected login to fail"),
      (error: unknown) => error,
    );

    for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
      await advance(0);
    }
    assert.equal(pollTimes.length, 1);

    await advance(15 * 60 * 1000);
    const rejection = await rejectionPromise;
    assert.ok(rejection instanceof Error);
    assert.equal(rejection.message, "Device flow timed out");
  });

  void test("treats OpenAI Codex device auth 403 and 404 responses as pending", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const accessToken = createAccessToken("account-403-404");
    const pollTimes: number[] = [];
    const pollResponses = [
      jsonResponse({ error: "access_denied", error_description: "denied" }, 403),
      new Response("not ready", { status: 404, headers: { "Content-Type": "text/plain" } }),
      jsonResponse({
        authorization_code: "oauth-code",
        code_challenge: "device-code-challenge",
        code_verifier: "device-code-verifier",
      }),
    ];

    stubFetch(async (input) => {
      const url = getUrl(input);
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: "1",
        });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        pollTimes.push(Date.now());
        const response = pollResponses.shift();
        if (!response) {
          throw new Error("Unexpected extra device auth poll");
        }
        return response;
      }
      if (url === "https://auth.openai.com/oauth/token") {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const credentialsPromise = loginOpenAICodexDeviceCodeForTest({
      onDeviceCode: () => {},
    });

    for (let i = 0; i < 5 && pollTimes.length === 0; i++) {
      await advance(0);
    }
    await advance(1000);
    await advance(1000);

    const credentials = await credentialsPromise;
    assert.equal(credentials.access, accessToken);
    assert.equal(credentials.refresh, "refresh-token");
    assert.equal(credentials["accountId"], "account-403-404");
    assert.equal(pollTimes.length, 3);
  });

  void test("includes the response body in OpenAI Codex device auth poll failures", async () => {
    stubFetch(async (input) => {
      const url = getUrl(input);
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-1234",
          interval: "5",
        });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        return jsonResponse({ error: "server_error", error_description: "try again later" }, 500);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    await assert.rejects(
      loginOpenAICodexDeviceCodeForTest({
        onDeviceCode: () => {},
      }),
      {
        message:
          'OpenAI Codex device auth failed with status 500: {"error":"server_error","error_description":"try again later"}',
      },
    );
  });

  void test("does not write token refresh failures to stderr", async () => {
    const consoleError = mock.method(console, "error", () => {});
    stubFetch(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "Could not validate your token. Please try signing in again.",
            type: "invalid_request_error",
          },
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await assert.rejects(
      openaiCodexOAuth.refresh(
        {
          type: "oauth",
          access: "invalid-access-token",
          refresh: "invalid-refresh-token",
          expires: 0,
        },
        neverAbortedSignal,
      ),
      /OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
    );
    assert.equal(consoleError.mock.callCount(), 0);
  });
});
