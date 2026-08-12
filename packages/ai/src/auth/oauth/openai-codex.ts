/**
 * OpenAI Codex (ChatGPT OAuth) flow, copied from pi-ai's implementation.
 * Browser login races a localhost callback server against a manual paste
 * prompt; device-code login covers headless boxes. Node-only (http server).
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { renderCallbackError, renderCallbackSuccess } from "./callback-page.ts";
import { generatePKCE } from "./pkce.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const ORIGINATOR = "june";

interface TokenData {
  access: string;
  refresh: string;
  expires: number;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split(".")[1];
    if (part === undefined) return undefined;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function getAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function credentialFromToken(token: TokenData): OAuthCredential {
  const accountId = getAccountId(token.access);
  if (accountId === null) throw new Error("Failed to extract accountId from token");
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId,
  };
}

async function readTokenResponse(response: Response, operation: string): Promise<TokenData> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token ${operation} failed (${String(response.status)}): ${text || response.statusText}`,
    );
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    json.access_token === undefined ||
    json.refresh_token === undefined ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error(`OpenAI Codex token ${operation} response missing fields`);
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<TokenData> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal: signal ?? null,
  });
  return readTokenResponse(response, "exchange");
}

async function refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<TokenData> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: signal ?? null,
  });
  return readTokenResponse(response, "refresh");
}

async function createAuthorizationFlow(): Promise<{
  verifier: string;
  state: string;
  url: string;
}> {
  const { verifier, challenge } = await generatePKCE();
  const state = randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", ORIGINATOR);
  return { verifier, state, url: url.toString() };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (value === "") return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    return { code: value };
  }
}

/**
 * Turn a bad callback into a one-line reason for the browser page, or
 * `undefined` when the callback looks usable.
 */
function describeCallbackFailure(
  url: URL,
  code: string | null,
  stateMatches: boolean,
): string | undefined {
  const error = url.searchParams.get("error");
  if (error !== null) {
    const description = url.searchParams.get("error_description");
    return description === null ? error : `${error}: ${description}`;
  }
  if (!stateMatches) return "State mismatch — the login may have been started elsewhere.";
  if (code === null) return "The redirect did not include an authorization code.";
  return undefined;
}

interface CallbackServer {
  close(): void;
  cancelWait(): void;
  waitForCode(): Promise<{ code: string } | null>;
}

function startLocalOAuthServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve) => {
    let settle: ((result: { code: string } | null) => void) | undefined;
    const waitPromise = new Promise<{ code: string } | null>((res) => {
      settle = (result) => {
        settle = undefined;
        res(result);
      };
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const failure = describeCallbackFailure(url, code, state === expectedState);
      if (failure !== undefined || code === null) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(renderCallbackError({ detail: failure }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderCallbackSuccess());
      settle?.({ code });
    });
    server
      .on("error", () => {
        settle?.(null);
        resolve({
          close: () => {},
          cancelWait: () => settle?.(null),
          waitForCode: () => waitPromise,
        });
      })
      .listen(1455, "127.0.0.1", () => {
        resolve({
          close: () => {
            try {
              server.close();
              server.closeAllConnections();
            } catch {
              // ignore
            }
          },
          cancelWait: () => settle?.(null),
          waitForCode: () => waitPromise,
        });
      });
  });
}

async function loginBrowser(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { verifier, state, url } = await createAuthorizationFlow();
  const server = await startLocalOAuthServer(state);
  const manualAbort = new AbortController();
  const onAbort = (): void => server.cancelWait();
  interaction.signal.addEventListener("abort", onAbort, { once: true });
  if (interaction.signal.aborted) onAbort();
  interaction.notify({
    type: "auth_url",
    url,
    instructions: "Open this URL in a browser and complete login to finish.",
  });
  try {
    let manualCode: string | undefined;
    let manualError: Error | undefined;
    const manualPromise = interaction
      .prompt({
        type: "manual_code",
        message: "Complete login in your browser, or paste the authorization code / redirect URL:",
        placeholder: REDIRECT_URI,
        signal: manualAbort.signal,
      })
      .then((input) => {
        manualCode = input;
        server.cancelWait();
      })
      .catch((error: unknown) => {
        manualError = error instanceof Error ? error : new Error(String(error));
        server.cancelWait();
      });
    const result = await server.waitForCode();
    if (interaction.signal.aborted) throw new Error("Login cancelled");
    let code = result?.code;
    if (code === undefined) {
      if (manualCode === undefined && manualError === undefined) await manualPromise;
      if (manualError !== undefined) throw manualError;
      if (manualCode !== undefined) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state !== undefined && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }
    }
    if (code === undefined) throw new Error("Missing authorization code");
    return credentialFromToken(
      await exchangeAuthorizationCode(code, verifier, REDIRECT_URI, interaction.signal),
    );
  } finally {
    interaction.signal.removeEventListener("abort", onAbort);
    manualAbort.abort();
    server.close();
  }
}

async function loginDeviceCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const started = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: interaction.signal,
  });
  if (!started.ok) {
    throw new Error(`OpenAI Codex device auth start failed (${String(started.status)})`);
  }
  const device = (await started.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
  };
  if (device.device_auth_id === undefined || device.user_code === undefined) {
    throw new Error("OpenAI Codex device auth response missing fields");
  }
  const intervalSeconds = Number(device.interval ?? 5) || 5;
  interaction.notify({
    type: "device_code",
    userCode: device.user_code,
    verificationUri: DEVICE_VERIFICATION_URI,
    intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
  });
  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
  let waitSeconds = intervalSeconds;
  for (;;) {
    if (interaction.signal.aborted) throw new Error("Login cancelled");
    if (Date.now() > deadline) throw new Error("Device code login timed out");
    await new Promise((res) => setTimeout(res, waitSeconds * 1000));
    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
      signal: interaction.signal,
    });
    if (response.status === 429) {
      waitSeconds += 5;
      continue;
    }
    if (!response.ok) {
      if (response.status >= 500) continue;
      throw new Error(`OpenAI Codex device auth poll failed (${String(response.status)})`);
    }
    const poll = (await response.json()) as {
      status?: string;
      authorization_code?: string;
      code_verifier?: string;
    };
    if (poll.status === "failed") throw new Error("OpenAI Codex device auth was denied");
    if (poll.authorization_code !== undefined && poll.code_verifier !== undefined) {
      return credentialFromToken(
        await exchangeAuthorizationCode(
          poll.authorization_code,
          poll.code_verifier,
          DEVICE_REDIRECT_URI,
          interaction.signal,
        ),
      );
    }
  }
}

export const openaiCodexOAuth: OAuthAuth = {
  name: "OpenAI (ChatGPT Plus/Pro)",
  isSubscription: true,
  async login(interaction) {
    const method = await interaction.prompt({
      type: "select",
      message: "Select OpenAI Codex login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
    if (method === "device_code") return loginDeviceCode(interaction);
    if (method !== "browser") throw new Error(`Unknown login method: ${method}`);
    return loginBrowser(interaction);
  },
  refresh: async (credential, signal) =>
    credentialFromToken(await refreshAccessToken(credential.refresh, signal)),
  async toAuth(credential) {
    const accountId =
      typeof credential["accountId"] === "string"
        ? credential["accountId"]
        : getAccountId(credential.access);
    if (accountId === null) throw new Error("OpenAI Codex credential missing account id");
    return {
      apiKey: credential.access,
      headers: { "chatgpt-account-id": accountId },
    };
  },
};
