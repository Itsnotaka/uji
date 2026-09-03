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
import catalogSnapshot from "./snapshots/opencode-catalog.json" with { type: "json" };
import {
  openCodeCatalogFetcher,
  parseOpenCodeCatalog,
  type OpenCodeCatalogOptions,
  type OpenCodeGoApi,
} from "./opencode-catalog.ts";

export function opencodeGoProvider(options: OpenCodeCatalogOptions = {}): Provider<OpenCodeGoApi> {
  return createProvider({
    id: "opencode-go",
    name: "OpenCode Go",
    // Uji-only field, no pi counterpart. Models route to several upstream APIs
    // whose long-retention windows differ (1h on Anthropic, 24h on OpenAI) and
    // some catalog entries do not support long retention at all, so publish
    // only the floor every route guarantees.
    promptCache: {
      minimumRetentionMs: { short: 5 * 60_000, long: 5 * 60_000 },
    },
    auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
    // Baked snapshot so a first boot with no network still has a catalog;
    // fetchModels overlays the live list when a refresh reaches the network.
    models: parseOpenCodeCatalog(catalogSnapshot, "opencode-go"),
    fetchModels: openCodeCatalogFetcher("opencode-go", options),
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  });
}
