export type {
  ApiKeyAuth,
  ApiKeyCredential,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthResult,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelAuth,
  OAuthAuth,
  OAuthCredential,
  ProviderAuth,
  ProviderAuthInteraction,
} from "./auth/types.ts";
export { defaultAuthPath, FileCredentialStore } from "./auth/store.ts";
export { resolveProviderAuth, type ResolveOptions } from "./auth/resolve.ts";
export { getAccountId, openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
export type { ModelInfo, Provider, ReasoningEffort, ResponsesApi } from "./provider.ts";
export { openaiProvider } from "./providers/openai.ts";
export { openaiCodexProvider } from "./providers/openai-codex.ts";
export { streamResponses, type ResponsesRequest } from "./api/responses.ts";

import type { Provider } from "./provider.ts";
import { openaiCodexProvider } from "./providers/openai-codex.ts";
import { openaiProvider } from "./providers/openai.ts";

/** Built-in provider blocks. Compositions can extend or replace this list. */
export function defaultProviders(): Provider[] {
  return [openaiCodexProvider(), openaiProvider()];
}

export function getProvider(providers: Provider[], id: string): Provider {
  const provider = providers.find((p) => p.id === id);
  if (provider === undefined) throw new Error(`Unknown provider: ${id}`);
  return provider;
}
