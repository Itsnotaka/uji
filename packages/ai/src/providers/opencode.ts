/**
 * OpenCode Zen provider.
 *
 * Based on https://github.com/earendil-works/pi/blob/77f2d1235ee2992c6072b9dcb6e99439a70c6f45/packages/ai/src/providers/opencode.ts
 * Synced with pi 77f2d1235.
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import {
  openCodeCatalogFetcher,
  type OpenCodeApi,
  type OpenCodeCatalogOptions,
} from "./opencode-catalog.ts";

export function opencodeProvider(options: OpenCodeCatalogOptions = {}): Provider<OpenCodeApi> {
  return createProvider({
    id: "opencode",
    name: "OpenCode Zen",
    auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
    models: [],
    fetchModels: openCodeCatalogFetcher("opencode", options),
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "google-generative-ai": googleGenerativeAIApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}
