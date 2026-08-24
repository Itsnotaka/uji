/**
 * OpenCode Go provider.
 *
 * Based on https://github.com/earendil-works/pi/blob/77f2d1235ee2992c6072b9dcb6e99439a70c6f45/packages/ai/src/providers/opencode-go.ts
 * Synced with pi 77f2d1235.
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import {
  openCodeCatalogFetcher,
  type OpenCodeCatalogOptions,
  type OpenCodeGoApi,
} from "./opencode-catalog.ts";

export function opencodeGoProvider(options: OpenCodeCatalogOptions = {}): Provider<OpenCodeGoApi> {
  return createProvider({
    id: "opencode-go",
    name: "OpenCode Go",
    auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
    models: [],
    fetchModels: openCodeCatalogFetcher("opencode-go", options),
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}
