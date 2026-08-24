/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/models-runtime.test.ts
 * Synced with pi 7ebf9087e.
 * The auth-resolution cases of pi's Models runtime suite, run against
 * resolveProviderAuth directly (Uji has no Models collection yet).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { resolveProviderAuth, type AuthResolutionOverrides } from "../src/auth/resolve.ts";
import type {
  ApiKeyAuth,
  AuthContext,
  CredentialStore,
  OAuthAuth,
  OAuthCredential,
  ProviderAuth,
} from "../src/auth/types.ts";

const ctx: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

function testProvider(input: { id: string; auth: ProviderAuth }): {
  id: string;
  auth: ProviderAuth;
} {
  return input;
}

function envKeyAuth(key: string | undefined): ApiKeyAuth {
  return {
    name: "Test API key",
    resolve: async ({ credential }) => {
      const resolved = credential?.key ?? key;
      if (!resolved) return undefined;
      return { auth: { apiKey: resolved }, source: credential ? "stored" : "env" };
    },
  };
}

function testOAuth(overrides?: Partial<OAuthAuth>): OAuthAuth {
  return {
    name: "Test OAuth",
    login: async () => {
      throw new Error("not used");
    },
    refresh: async (credential) => credential,
    toAuth: async (credential) => ({ apiKey: credential.access }),
    ...overrides,
  };
}

function getAuth(
  provider: { id: string; auth: ProviderAuth },
  credentials: CredentialStore,
  overrides?: AuthResolutionOverrides,
) {
  return resolveProviderAuth(provider, credentials, ctx, overrides);
}

void describe("resolveProviderAuth", () => {
  void test("cancels queued credential mutations without running them later", async () => {
    const credentials = new InMemoryCredentialStore();
    let finishFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let secondRan = false;
    const first = credentials.modify("p1", async () => {
      await firstBlocked;
      return { type: "api_key", key: "first" };
    });
    const controller = new AbortController();
    const second = credentials.modify(
      "p1",
      async () => {
        secondRan = true;
        return { type: "api_key", key: "second" };
      },
      { signal: controller.signal },
    );

    controller.abort();
    await assert.rejects(second, { name: "AbortError" });
    finishFirst?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(secondRan, false);
    assert.deepEqual(await credentials.read("p1"), { type: "api_key", key: "first" });
  });

  void test("passes cancellation to OAuth refresh and preserves the previous credential", async () => {
    const credentials = new InMemoryCredentialStore();
    const previous: OAuthCredential = {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: 0,
    };
    await credentials.modify("p1", async () => previous);
    let startRefresh: (() => void) | undefined;
    let finishRefresh: ((credential: typeof previous) => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      startRefresh = resolve;
    });
    const blockedRefresh = new Promise<typeof previous>((resolve) => {
      finishRefresh = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const provider = testProvider({
      id: "p1",
      auth: {
        oauth: testOAuth({
          refresh: async (_credential, signal) => {
            receivedSignal = signal;
            startRefresh?.();
            return blockedRefresh;
          },
        }),
      },
    });
    const controller = new AbortController();
    const auth = getAuth(provider, credentials, { signal: controller.signal });
    await refreshStarted;
    controller.abort();

    await assert.rejects(auth, { name: "AbortError" });
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(receivedSignal.reason, controller.signal.reason);
    finishRefresh?.({ ...previous, access: "new", expires: Date.now() + 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(await credentials.read("p1"), previous);
  });

  void test("resolves auth: stored credential owns the provider, ambient only when nothing stored", async () => {
    const credentials = new InMemoryCredentialStore();
    const provider = testProvider({
      id: "p1",
      auth: { apiKey: envKeyAuth("env-key"), oauth: testOAuth() },
    });

    assert.equal((await getAuth(provider, credentials))?.auth.apiKey, "env-key");
    assert.equal(
      (await getAuth(provider, credentials, { apiKey: "explicit-key" }))?.auth.apiKey,
      "explicit-key",
    );

    // stored oauth credential (persisted via the single write path): beats ambient env
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "oauth-token",
      refresh: "r",
      expires: Date.now() + 10 * 60_000,
    }));
    const resolution = await getAuth(provider, credentials);
    assert.equal(resolution?.auth.apiKey, "oauth-token");
    assert.equal(resolution?.source, "OAuth");

    // stored api-key credential resolves through apiKey auth, beats env
    await credentials.modify("p1", async () => ({ type: "api_key", key: "stored-key" }));
    const apiKeyResolution = await getAuth(provider, credentials);
    assert.equal(apiKeyResolution?.auth.apiKey, "stored-key");
    assert.equal(apiKeyResolution?.source, "stored");
  });

  void test("a stored credential without a matching handler blocks ambient fallback", async () => {
    const credentials = new InMemoryCredentialStore();
    // provider has only apiKey auth, but an oauth credential is stored (stale config)
    const provider = testProvider({ id: "p1", auth: { apiKey: envKeyAuth("env-key") } });
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 0,
    }));

    assert.equal(await getAuth(provider, credentials), undefined);
  });

  void test("refreshes expired oauth credentials and persists the rotated credential", async () => {
    const credentials = new InMemoryCredentialStore();
    const oauth = testOAuth({
      refresh: async (credential) => ({
        ...credential,
        access: "new-token",
        expires: Date.now() + 60 * 60_000,
      }),
    });
    const provider = testProvider({ id: "p1", auth: { oauth } });
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "old-token",
      refresh: "r",
      expires: 0,
    }));

    const resolution = await getAuth(provider, credentials);
    assert.equal(resolution?.auth.apiKey, "new-token");
    assert.equal(((await credentials.read("p1")) as { access: string }).access, "new-token");
  });

  void test("refreshes oauth credentials with less than five minutes remaining", async () => {
    const credentials = new InMemoryCredentialStore();
    let refreshes = 0;
    const provider = testProvider({
      id: "p1",
      auth: {
        oauth: testOAuth({
          refresh: async (credential) => {
            refreshes++;
            return { ...credential, access: "new-token", expires: Date.now() + 60 * 60_000 };
          },
        }),
      },
    });
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "old-token",
      refresh: "r",
      expires: Date.now() + 60_000,
    }));

    assert.equal((await getAuth(provider, credentials))?.auth.apiKey, "new-token");
    assert.equal(refreshes, 1);
  });

  void test("honors a caller's longer OAuth minimum validity", async () => {
    const credentials = new InMemoryCredentialStore();
    let refreshes = 0;
    const provider = testProvider({
      id: "p1",
      auth: {
        oauth: testOAuth({
          refresh: async (credential) => {
            refreshes++;
            return { ...credential, access: "new-token", expires: Date.now() + 60 * 60_000 };
          },
        }),
      },
    });
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "old-token",
      refresh: "r",
      expires: Date.now() + 10 * 60_000,
    }));

    assert.equal(
      (await getAuth(provider, credentials, { minOAuthValidityMs: 30 * 60_000 }))?.auth.apiKey,
      "new-token",
    );
    assert.equal(refreshes, 1);
  });

  void test("rejects with code oauth when refresh fails, preserving the stored credential", async () => {
    const credentials = new InMemoryCredentialStore();
    const oauth = testOAuth({
      refresh: async () => {
        throw new Error("invalid_grant");
      },
    });
    const provider = testProvider({ id: "p1", auth: { oauth } });
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "old",
      refresh: "r",
      expires: 0,
    }));

    await assert.rejects(getAuth(provider, credentials), { code: "oauth" });
    // credential preserved for retry / re-login
    assert.equal(((await credentials.read("p1")) as { access: string }).access, "old");
  });

  void test("serializes concurrent OAuth refreshes through store.modify (no double refresh)", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "old",
      refresh: "r1",
      expires: 0,
    }));

    let refreshes = 0;
    const oauth = testOAuth({
      refresh: async () => {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          type: "oauth",
          access: `new-${refreshes}`,
          refresh: "r2",
          expires: Date.now() + 60 * 60_000,
        };
      },
    });
    const provider = testProvider({ id: "p1", auth: { oauth } });

    const [a, b] = await Promise.all([
      getAuth(provider, credentials),
      getAuth(provider, credentials),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(a?.auth.apiKey, "new-1");
    assert.equal(b?.auth.apiKey, "new-1");
  });

  void test("valid oauth tokens resolve without touching modify", async () => {
    let modifies = 0;
    const base = new InMemoryCredentialStore();
    const credentials: CredentialStore = {
      read: (pid) => base.read(pid),
      list: () => base.list(),
      modify: (pid, fn) => {
        modifies++;
        return base.modify(pid, fn);
      },
      delete: (pid) => base.delete(pid),
    };
    await base.modify("p1", async () => ({
      type: "oauth",
      access: "valid",
      refresh: "r",
      expires: Date.now() + 10 * 60_000,
    }));
    const provider = testProvider({ id: "p1", auth: { oauth: testOAuth() } });

    assert.equal((await getAuth(provider, credentials))?.auth.apiKey, "valid");
    assert.equal(modifies, 0);
  });

  void test("wraps credential store failures in ModelsError", async () => {
    // read failure
    const readFailing: CredentialStore = {
      read: async () => {
        throw new Error("disk on fire");
      },
      list: async () => [],
      modify: async () => undefined,
      delete: async () => {},
    };
    const provider = testProvider({ id: "p1", auth: { apiKey: envKeyAuth("env-key") } });
    await assert.rejects(getAuth(provider, readFailing), { code: "auth" });

    // modify failure during refresh
    const modifyFailing: CredentialStore = {
      read: async () => ({ type: "oauth", access: "old", refresh: "r", expires: 0 }),
      list: async () => [{ providerId: "p1", type: "oauth" }],
      modify: async () => {
        throw new Error("disk on fire");
      },
      delete: async () => {},
    };
    const oauthProvider = testProvider({ id: "p1", auth: { oauth: testOAuth() } });
    await assert.rejects(getAuth(oauthProvider, modifyFailing), { code: "auth" });
  });

  void test("keeps the underlying reason in wrapped oauth refresh errors", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("p1", async () => ({
      type: "oauth",
      access: "old",
      refresh: "r",
      expires: 0,
    }));
    const provider = testProvider({
      id: "p1",
      auth: {
        oauth: testOAuth({
          refresh: async () => {
            throw new Error("token refresh failed (400): invalid_grant");
          },
        }),
      },
    });

    await assert.rejects(getAuth(provider, credentials), {
      message: "OAuth refresh failed for p1: token refresh failed (400): invalid_grant",
    });
  });

  void test("wraps api-key auth failures in ModelsError", async () => {
    const failing: ApiKeyAuth = {
      name: "Failing",
      resolve: async () => {
        throw new Error("nope");
      },
    };
    const provider = testProvider({ id: "p1", auth: { apiKey: failing } });
    await assert.rejects(getAuth(provider, new InMemoryCredentialStore()), { code: "auth" });
  });

  void test("uses explicit request api key and env during provider auth resolution", async () => {
    const apiKey: ApiKeyAuth = {
      name: "Scoped",
      resolve: async ({ credential, ctx }) => {
        const account = credential?.env?.ACCOUNT_ID ?? (await ctx.env("ACCOUNT_ID"));
        if (!credential?.key || !account) return undefined;
        return {
          auth: { apiKey: credential.key, baseUrl: `https://example.test/${account}` },
          env: { ACCOUNT_ID: account },
        };
      },
    };
    const provider = testProvider({ id: "p1", auth: { apiKey } });

    const result = await getAuth(provider, new InMemoryCredentialStore(), {
      apiKey: "explicit-key",
      env: { ACCOUNT_ID: "acct" },
    });
    assert.equal(result?.auth.baseUrl, "https://example.test/acct");
    assert.equal(result?.auth.apiKey, "explicit-key");
    assert.deepEqual(result?.env, { ACCOUNT_ID: "acct" });
  });
});
