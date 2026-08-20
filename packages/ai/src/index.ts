/**
 * @june/ai: the provider layer. Side-effect free: provider factories and API
 * implementations are exported explicitly below; nothing registers globally.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/index.ts
 * Synced with pi 7ebf9087e.
 */
export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

export type {
  AnthropicEffort,
  AnthropicOptions,
  AnthropicThinkingDisplay,
} from "./api/anthropic-messages.ts";
export * from "./api/lazy.ts";
export type {
  OpenAICodexResponsesOptions,
  OpenAICodexWebSocketDebugStats,
} from "./api/openai-codex-responses.ts";
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
export * from "./auth/context.ts";
export * from "./auth/credential-store.ts";
export * from "./auth/helpers.ts";
export * from "./auth/types.ts";
export { defaultAuthPath, FileCredentialStore } from "./auth/store.ts";
export {
  ModelsError,
  resolveProviderAuth,
  type AuthResolutionOverrides,
  type ModelsErrorCode,
} from "./auth/resolve.ts";
export { anthropicOAuth } from "./auth/oauth/anthropic.ts";
export { getAccountId, openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
export {
  loadAnthropicOAuth,
  loadOpenAICodexOAuth,
  registerBundledOAuthFlowLoaders,
} from "./auth/oauth/load.ts";
export { oauthErrorHtml, oauthSuccessHtml } from "./auth/oauth/oauth-page.ts";
export { generatePKCE } from "./auth/oauth/pkce.ts";
export {
  abortableSleep,
  pollOAuthDeviceCodeFlow,
  type OAuthDeviceCodePollOptions,
  type OAuthDeviceCodePollResult,
} from "./auth/oauth/device-code.ts";
export * from "./env-api-keys.ts";
export * from "./models.ts";
export * from "./models-store.ts";
export * from "./session-resources.ts";
export * from "./types.ts";
export * from "./utils/assistant-message-frame.ts";
export * from "./utils/diagnostics.ts";
export * from "./utils/estimate.ts";
export * from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export * from "./utils/overflow.ts";
export * from "./utils/retry.ts";
export { contentText } from "./utils/text.ts";
export * from "./utils/typebox-helpers.ts";
export { uuidv7 } from "./utils/uuid.ts";
export * from "./utils/validation.ts";

export { anthropicProvider } from "./providers/anthropic.ts";
export { openaiProvider } from "./providers/openai.ts";
export { openaiCodexProvider } from "./providers/openai-codex.ts";
