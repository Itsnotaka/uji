import { MODEL_THINKING_LEVELS } from "@uji-ai/schema";
import type { RefreshModelsContext } from "../models.ts";
import type {
  AnthropicMessagesCompat,
  FetchFunction,
  Model,
  ModelCost,
  ModelCostTier,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "../types.ts";

export type OpenCodeApi =
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-completions"
  | "openai-responses";
export type OpenCodeGoApi = Exclude<OpenCodeApi, "google-generative-ai">;

export type OpenCodeProviderId = "opencode" | "opencode-go";

export interface OpenCodeCatalogOptions {
  fetch?: FetchFunction;
}

const CATALOG_URL = "https://models.opencode.ai/api.json";

const PROVIDERS = {
  opencode: { basePath: "https://opencode.ai/zen" },
  "opencode-go": { basePath: "https://opencode.ai/zen/go" },
} satisfies Record<OpenCodeProviderId, { basePath: string }>;

const LONG_CACHE_RETENTION_UNSUPPORTED = new Set([
  "opencode:deepseek-v4-flash",
  "opencode:deepseek-v4-pro",
  "opencode:kimi-k2.5",
  "opencode:kimi-k2.6",
  "opencode:minimax-m2.7",
  "opencode-go:kimi-k2.6",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function parseCostTier(value: unknown): ModelCostTier | undefined {
  if (!isRecord(value) || !isRecord(value["tier"])) return undefined;
  const tier = value["tier"];
  if (tier["type"] !== "context") return undefined;
  const inputTokensAbove = positiveNumber(tier["size"], 0);
  if (inputTokensAbove === 0) return undefined;
  return {
    inputTokensAbove,
    input: finiteNumber(value["input"], 0),
    output: finiteNumber(value["output"], 0),
    cacheRead: finiteNumber(value["cache_read"], 0),
    cacheWrite: finiteNumber(value["cache_write"], 0),
  };
}

function parseCost(value: unknown): ModelCost {
  if (!isRecord(value)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const tiers = Array.isArray(value["tiers"])
    ? value["tiers"].flatMap((tier) => {
        const parsed = parseCostTier(tier);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  return {
    input: finiteNumber(value["input"], 0),
    output: finiteNumber(value["output"], 0),
    cacheRead: finiteNumber(value["cache_read"], 0),
    cacheWrite: finiteNumber(value["cache_write"], 0),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = new Set<string>();
  for (const option of value) {
    if (!isRecord(option) || option["type"] !== "effort" || !Array.isArray(option["values"])) {
      continue;
    }
    for (const effort of option["values"]) {
      if (typeof effort === "string") efforts.add(effort);
    }
  }
  if (efforts.size === 0) return undefined;
  const map: ThinkingLevelMap = { off: efforts.has("none") ? "none" : null };
  for (const level of MODEL_THINKING_LEVELS) {
    if (level === "off") continue;
    map[level] = efforts.has(level) ? level : null;
  }
  return map;
}

function isAnthropicAdaptiveModel(id: string): boolean {
  return /(?:opus-(?:4[.-][6-9]|5)|sonnet-(?:4[.-]6|5)|fable-5)/.test(id.toLowerCase());
}

function isAnthropicTemperatureUnsupported(id: string): boolean {
  return /opus-(?:4[.-][7-9]|5)/.test(id.toLowerCase());
}

function anthropicCompat(id: string): AnthropicMessagesCompat | undefined {
  const compat: AnthropicMessagesCompat = {};
  if (isAnthropicAdaptiveModel(id)) compat.forceAdaptiveThinking = true;
  if (isAnthropicTemperatureUnsupported(id)) compat.supportsTemperature = false;
  return Object.keys(compat).length === 0 ? undefined : compat;
}

function completionsCompat(
  provider: OpenCodeProviderId,
  id: string,
  npm: string,
): OpenAICompletionsCompat {
  const compat: OpenAICompletionsCompat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  };
  if (npm === "@ai-sdk/alibaba") compat.cacheControlFormat = "anthropic";
  if (LONG_CACHE_RETENTION_UNSUPPORTED.has(`${provider}:${id}`)) {
    compat.supportsLongCacheRetention = false;
  }
  if (id === "kimi-k2.6") {
    compat.thinkingFormat = "deepseek";
    compat.supportsReasoningEffort = false;
  }
  if (id.includes("deepseek-v4")) {
    compat.requiresReasoningContentOnAssistantMessages = true;
    if (provider === "opencode-go") compat.thinkingFormat = "deepseek";
  }
  if (provider === "opencode-go" && id.startsWith("qwen3.")) {
    compat.thinkingFormat = "qwen";
    compat.supportsReasoningEffort = false;
  }
  return compat;
}

function responsesCompat(): OpenAIResponsesCompat {
  return { sessionAffinityFormat: "openai-nosession" };
}

function googleThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
  const lower = id.toLowerCase();
  if (/gemini-3(?:\.\d+)?-pro/.test(lower)) {
    return { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" };
  }
  if (/gemini-3(?:\.\d+)?-flash/.test(lower)) return { off: null };
  return undefined;
}

function anthropicThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
  const lower = id.toLowerCase();
  if (lower.includes("fable-5")) return { off: null, xhigh: "xhigh", max: "max" };
  if (/(?:opus-(?:4[.-][7-9]|5)|sonnet-5)/.test(lower)) {
    return { xhigh: "xhigh", max: "max" };
  }
  if (/(?:opus-4[.-]6|sonnet-4[.-]6)/.test(lower)) return { max: "max" };
  return undefined;
}

function mergeThinkingLevelMaps(
  base: ThinkingLevelMap | undefined,
  override: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return { ...base, ...override };
}

function apiForNpm(npm: string): OpenCodeApi | undefined {
  switch (npm) {
    case "@ai-sdk/anthropic":
      return "anthropic-messages";
    case "@ai-sdk/google":
      return "google-generative-ai";
    case "@ai-sdk/openai-compatible":
    case "@ai-sdk/alibaba":
      return "openai-completions";
    case "@ai-sdk/openai":
      return "openai-responses";
    default:
      return undefined;
  }
}

function parseModel(
  providerId: OpenCodeProviderId,
  catalogId: string,
  providerNpm: string | undefined,
  value: unknown,
): Model<OpenCodeApi> | undefined {
  if (!isRecord(value) || value["tool_call"] !== true || value["status"] === "deprecated") {
    return undefined;
  }
  const id = optionalString(value["id"]);
  if (id === undefined || id !== catalogId) return undefined;
  const modelProvider = isRecord(value["provider"]) ? value["provider"] : undefined;
  const npm = optionalString(modelProvider?.["npm"]) ?? providerNpm;
  if (npm === undefined) return undefined;
  const api = apiForNpm(npm);
  if (api === undefined) return undefined;
  if (providerId === "opencode-go" && api === "google-generative-ai") return undefined;
  const modalities = isRecord(value["modalities"]) ? value["modalities"] : undefined;
  const inputs = Array.isArray(modalities?.["input"]) ? modalities["input"] : [];
  const input: Model<OpenCodeApi>["input"] = inputs.includes("image")
    ? ["text", "image"]
    : ["text"];
  const limit = isRecord(value["limit"]) ? value["limit"] : undefined;
  const basePath = PROVIDERS[providerId].basePath;
  const remoteThinkingLevelMap = parseThinkingLevelMap(value["reasoning_options"]);
  const common = {
    id,
    name: optionalString(value["name"]) ?? id,
    provider: providerId,
    reasoning: value["reasoning"] === true,
    input,
    cost: parseCost(value["cost"]),
    contextWindow: positiveNumber(limit?.["context"], 4096),
    maxTokens: positiveNumber(limit?.["output"], 4096),
  };

  switch (api) {
    case "anthropic-messages": {
      const thinkingLevelMap = mergeThinkingLevelMaps(
        remoteThinkingLevelMap,
        anthropicThinkingLevelMap(id),
      );
      const compat = anthropicCompat(id);
      return {
        ...common,
        api,
        baseUrl: basePath,
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
        ...(compat === undefined ? {} : { compat }),
      };
    }
    case "google-generative-ai": {
      const thinkingLevelMap = mergeThinkingLevelMaps(
        remoteThinkingLevelMap,
        googleThinkingLevelMap(id),
      );
      return {
        ...common,
        api,
        baseUrl: `${basePath}/v1`,
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      };
    }
    case "openai-completions":
      return {
        ...common,
        api,
        baseUrl: `${basePath}/v1`,
        ...(remoteThinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: remoteThinkingLevelMap }),
        compat: completionsCompat(providerId, id, npm),
      };
    case "openai-responses":
      return {
        ...common,
        api,
        baseUrl: `${basePath}/v1`,
        ...(remoteThinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: remoteThinkingLevelMap }),
        compat: responsesCompat(),
      };
  }
}

export function parseOpenCodeCatalog(
  value: unknown,
  providerId: "opencode",
): readonly Model<OpenCodeApi>[];
export function parseOpenCodeCatalog(
  value: unknown,
  providerId: "opencode-go",
): readonly Model<OpenCodeGoApi>[];
export function parseOpenCodeCatalog(
  value: unknown,
  providerId: OpenCodeProviderId,
): readonly Model<OpenCodeApi>[];
export function parseOpenCodeCatalog(
  value: unknown,
  providerId: OpenCodeProviderId,
): readonly Model<OpenCodeApi>[] {
  if (!isRecord(value) || !isRecord(value[providerId])) {
    throw new Error(`OpenCode catalog does not contain provider ${providerId}`);
  }
  const provider = value[providerId];
  if (!isRecord(provider["models"])) {
    throw new Error(`OpenCode catalog has no models for provider ${providerId}`);
  }
  const providerNpm = optionalString(provider["npm"]);
  const models = Object.entries(provider["models"]).flatMap(([id, model]) => {
    const parsed = parseModel(providerId, id, providerNpm, model);
    return parsed === undefined ? [] : [parsed];
  });
  if (models.length === 0) {
    throw new Error(`OpenCode catalog has no compatible tool models for provider ${providerId}`);
  }
  return models.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export function openCodeCatalogFetcher(
  providerId: "opencode",
  options?: OpenCodeCatalogOptions,
): (context: RefreshModelsContext) => Promise<readonly Model<OpenCodeApi>[]>;
export function openCodeCatalogFetcher(
  providerId: "opencode-go",
  options?: OpenCodeCatalogOptions,
): (context: RefreshModelsContext) => Promise<readonly Model<OpenCodeGoApi>[]>;
export function openCodeCatalogFetcher(
  providerId: OpenCodeProviderId,
  options: OpenCodeCatalogOptions = {},
): (context: RefreshModelsContext) => Promise<readonly Model<OpenCodeApi>[]> {
  const fetchCatalog = options.fetch ?? globalThis.fetch;
  return async ({ signal }) => {
    const response = await fetchCatalog(CATALOG_URL, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode catalog request failed with HTTP ${String(response.status)}`);
    }
    const value: unknown = await response.json();
    return parseOpenCodeCatalog(value, providerId);
  };
}
