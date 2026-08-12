import process from "node:process";
import type { Provider } from "../provider.ts";
import type { AuthResult, CredentialStore } from "./types.ts";

const DEFAULT_MIN_OAUTH_VALIDITY_MS = 5 * 60 * 1000;

export interface ResolveOptions {
  /** Require this much remaining OAuth-token validity; defaults to five minutes. */
  minOAuthValidityMs?: number;
  env?: (name: string) => string | undefined;
  signal?: AbortSignal;
}

/**
 * Resolve request auth for a provider (pi-shaped). A stored credential owns
 * the provider: ambient/env is consulted only when nothing is stored. OAuth
 * refresh runs inside `store.modify` so concurrent requests cannot
 * double-refresh a rotated token. Returns undefined when not configured.
 */
export async function resolveProviderAuth(
  provider: Provider,
  store: CredentialStore,
  options?: ResolveOptions,
): Promise<AuthResult | undefined> {
  const env = options?.env ?? ((name: string) => process.env[name]);
  const minValidity = options?.minOAuthValidityMs ?? DEFAULT_MIN_OAUTH_VALIDITY_MS;
  const credential = await store.read(provider.id);

  if (credential?.type === "oauth") {
    const oauth = provider.auth.oauth;
    if (oauth === undefined) {
      throw new Error(`Provider ${provider.id} has an oauth credential but no oauth auth`);
    }
    let current = credential;
    if (current.expires - Date.now() < minValidity) {
      const updated = await store.modify(provider.id, async (stored) => {
        if (stored?.type !== "oauth") return undefined;
        if (stored.expires - Date.now() >= minValidity) return undefined;
        return oauth.refresh(stored, options?.signal);
      });
      if (updated?.type !== "oauth")
        throw new Error(`OAuth refresh lost ${provider.id} credential`);
      current = updated;
    }
    return { auth: await oauth.toAuth(current), source: "OAuth" };
  }

  if (credential?.type === "api_key") {
    return provider.auth.apiKey?.resolve({ env, credential });
  }
  return provider.auth.apiKey?.resolve({ env });
}
