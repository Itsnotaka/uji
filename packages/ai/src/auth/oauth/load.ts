/**
 * Lazy loaders for the built-in OAuth flows. Provider definitions advertise
 * OAuth through `lazyOAuth` + one of these, so the Node-only flow modules
 * (callback servers, PKCE) are imported only when a login or refresh runs.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/auth/oauth/load.ts
 * Synced with pi 7ebf9087e.
 */
import type { OAuthAuth } from "../types.ts";

/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output.
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
  const runtimeSpecifier = import.meta.url.endsWith(".js")
    ? specifier.replace(/\.ts$/, ".js")
    : specifier;
  return import(runtimeSpecifier);
};

type OAuthFlowLoaders = {
  anthropic: () => OAuthAuth | Promise<OAuthAuth>;
  openaiCodex: () => OAuthAuth | Promise<OAuthAuth>;
};

let bundledLoaders: OAuthFlowLoaders | undefined;

/** Registers statically bundled OAuth flows for standalone Bun binaries. */
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
  bundledLoaders = loaders;
}

export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => {
  if (bundledLoaders) return bundledLoaders.anthropic();
  return ((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth })
    .anthropicOAuth;
};

export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => {
  if (bundledLoaders) return bundledLoaders.openaiCodex();
  return ((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth })
    .openaiCodexOAuth;
};
