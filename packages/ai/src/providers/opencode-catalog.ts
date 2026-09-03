import { MODEL_THINKING_LEVELS } from "@uji-ai/schema";
import { Type } from "typebox";
import { Value } from "typebox/value";
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

/**
 * The catalog is a third-party feed and only `id` and `tool_call` decide whether
 * a model is usable at all. Every other field is advisory: the schemas name the
 * keys this parser reads but leave their values unconstrained, and each read
 * narrows the one value it needs, so a wrong-typed `name`, price, or limit falls
 * back on its own instead of deleting the model.
 */
const CatalogModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  tool_call: Type.Literal(true),
  name: Type.Optional(Type.Unknown()),
  status: Type.Optional(Type.Unknown()),
  reasoning: Type.Optional(Type.Unknown()),
  provider: Type.Optional(Type.Unknown()),
  modalities: Type.Optional(Type.Unknown()),
  limit: Type.Optional(Type.Unknown()),
  cost: Type.Optional(Type.Unknown()),
  reasoning_options: Type.Optional(Type.Unknown()),
});

const CatalogModelProviderSchema = Type.Object({ npm: Type.Optional(Type.Unknown()) });

const CatalogModalitiesSchema = Type.Object({ input: Type.Optional(Type.Unknown()) });

const CatalogLimitSchema = Type.Object({
  context: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.Unknown()),
});

const CatalogCostSchema = Type.Object({
  input: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.Unknown()),
  cache_read: Type.Optional(Type.Unknown()),
  cache_write: Type.Optional(Type.Unknown()),
  tiers: Type.Optional(Type.Unknown()),
});

const CatalogCostTierSchema = Type.Object({
  input: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.Unknown()),
  cache_read: Type.Optional(Type.Unknown()),
  cache_write: Type.Optional(Type.Unknown()),
  tier: Type.Optional(Type.Unknown()),
});

const CatalogTierSchema = Type.Object({
  type: Type.Optional(Type.Unknown()),
  size: Type.Optional(Type.Unknown()),
});

const CatalogReasoningOptionSchema = Type.Object({
  type: Type.Optional(Type.Unknown()),
  values: Type.Optional(Type.Unknown()),
});

const CatalogProviderSchema = Type.Object({
  npm: Type.Optional(Type.Unknown()),
  models: Type.Optional(Type.Unknown()),
});

const CatalogModelsSchema = Type.Record(Type.String(), Type.Unknown());

/**
 * The two provider subtrees this package consumes. Exported for
 * `scripts/snapshot-opencode-catalog.ts`, which must extract the same shape it parses.
 * Each subtree stays unconstrained here so a malformed `opencode-go` cannot take
 * `opencode` down with it; both are checked one at a time in parseOpenCodeCatalog.
 */
export const OpenCodeCatalogSchema = Type.Object({
  opencode: Type.Optional(Type.Unknown()),
  "opencode-go": Type.Optional(Type.Unknown()),
});

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

function jsonArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseCostTier(value: unknown): ModelCostTier | undefined {
  if (!Value.Check(CatalogCostTierSchema, value)) return undefined;
  const tier = value.tier;
  if (!Value.Check(CatalogTierSchema, tier)) return undefined;
  if (tier.type !== "context") return undefined;
  const inputTokensAbove = positiveNumber(tier.size, 0);
  if (inputTokensAbove === 0) return undefined;
  return {
    inputTokensAbove,
    input: finiteNumber(value.input, 0),
    output: finiteNumber(value.output, 0),
    cacheRead: finiteNumber(value.cache_read, 0),
    cacheWrite: finiteNumber(value.cache_write, 0),
  };
}

function parseCost(value: unknown): ModelCost {
  if (!Value.Check(CatalogCostSchema, value)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const tiers = jsonArray(value.tiers).flatMap((tier) => {
    const parsed = parseCostTier(tier);
    return parsed === undefined ? [] : [parsed];
  });
  return {
    input: finiteNumber(value.input, 0),
    output: finiteNumber(value.output, 0),
    cacheRead: finiteNumber(value.cache_read, 0),
    cacheWrite: finiteNumber(value.cache_write, 0),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  const efforts = new Set<string>();
  for (const option of jsonArray(value)) {
    if (!Value.Check(CatalogReasoningOptionSchema, option)) continue;
    if (option.type !== "effort") continue;
    for (const effort of jsonArray(option.values)) {
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
  if (!Value.Check(CatalogModelSchema, value)) return undefined;
  if (value.status === "deprecated") return undefined;
  const id = value.id;
  if (id !== catalogId) return undefined;
  const modelProvider = Value.Check(CatalogModelProviderSchema, value.provider)
    ? value.provider
    : undefined;
  const npm = optionalString(modelProvider?.npm) ?? providerNpm;
  if (npm === undefined) return undefined;
  const api = apiForNpm(npm);
  if (api === undefined) return undefined;
  if (providerId === "opencode-go" && api === "google-generative-ai") return undefined;
  const modalities = Value.Check(CatalogModalitiesSchema, value.modalities)
    ? value.modalities
    : undefined;
  const input: Model<OpenCodeApi>["input"] = jsonArray(modalities?.input).includes("image")
    ? ["text", "image"]
    : ["text"];
  const limit = Value.Check(CatalogLimitSchema, value.limit) ? value.limit : undefined;
  const basePath = PROVIDERS[providerId].basePath;
  const remoteThinkingLevelMap = parseThinkingLevelMap(value.reasoning_options);
  const common = {
    id,
    name: optionalString(value.name) ?? id,
    provider: providerId,
    reasoning: value.reasoning === true,
    input,
    cost: parseCost(value.cost),
    contextWindow: positiveNumber(limit?.context, 4096),
    maxTokens: positiveNumber(limit?.output, 4096),
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
  const subtree = Value.Check(OpenCodeCatalogSchema, value) ? value[providerId] : undefined;
  if (!Value.Check(CatalogProviderSchema, subtree)) {
    throw new Error(`OpenCode catalog does not contain provider ${providerId}`);
  }
  const catalogModels = subtree.models;
  if (!Value.Check(CatalogModelsSchema, catalogModels)) {
    throw new Error(`OpenCode catalog has no models for provider ${providerId}`);
  }
  const providerNpm = optionalString(subtree.npm);
  const models = Object.entries(catalogModels).flatMap(([id, model]) => {
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
