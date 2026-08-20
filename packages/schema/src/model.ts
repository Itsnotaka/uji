/**
 * A model as the harness and clients see it: identity, which wire dialect and
 * provider serve it, what it can take in, what it costs, and per-dialect
 * compatibility switches an adapter reads. Carried verbatim from pi so the
 * generated catalog and every adapter type-check against the same shapes.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/types.ts
 * Synced with pi 7ebf9087e.
 */

/** Reasoning effort actually sent on the wire. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** What a model or lane is configured to: a level, or reasoning off. */
export type ModelThinkingLevel = "off" | ThinkingLevel;
/**
 * Maps thinking levels to provider/model-specific values.
 * Missing keys use provider defaults. `null` marks a level as unsupported.
 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type KnownApi =
  | "openai-completions"
  | "mistral-conversations"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-vertex"
  | "pi-messages";

export type Api = KnownApi | (string & {});

export type KnownProvider =
  | "amazon-bedrock"
  | "ant-ling"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "openai"
  | "azure-openai-responses"
  | "openai-codex"
  | "radius"
  | "nvidia"
  | "deepseek"
  | "github-copilot"
  | "xai"
  | "groq"
  | "cerebras"
  | "openrouter"
  | "vercel-ai-gateway"
  | "zai"
  | "zai-coding-cn"
  | "mistral"
  | "minimax"
  | "minimax-cn"
  | "moonshotai"
  | "moonshotai-cn"
  | "huggingface"
  | "fireworks"
  | "together"
  | "baseten"
  | "opencode"
  | "opencode-go"
  | "kimi-coding"
  | "cloudflare-workers-ai"
  | "cloudflare-ai-gateway"
  | "qwen-token-plan"
  | "qwen-token-plan-cn"
  | "qwen-token-plan-individual"
  | "xiaomi"
  | "xiaomi-token-plan-cn"
  | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;

export type ChatTemplateKwargValue =
  | string
  | number
  | boolean
  | null
  | {
      $var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
      omitWhenOff?: boolean;
    };

/** Top-level request field used to cap reasoning tokens on OpenAI-compatible servers. */
export type ThinkingTokenBudgetField =
  | "thinking_token_budget"
  | "thinking_budget"
  | "thinking_budget_tokens";

export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface AnthropicAllowedFallbackModel {
  provider: ProviderId;
  model: string;
  cost: ModelCost;
}

export interface ModelCostRates {
  input: number; // $/million tokens
  output: number; // $/million tokens
  cacheRead: number; // $/million tokens
  cacheWrite: number; // $/million tokens
}

export interface ModelCostTier extends ModelCostRates {
  /** Use this tier for requests whose total input usage exceeds this token count. */
  inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
  /** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
  tiers?: ModelCostTier[];
}

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompletionsCompat {
  /** Whether the provider supports the `store` field. Default: auto-detected from URL. */
  supportsStore?: boolean;
  /** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
  supportsDeveloperRole?: boolean;
  /** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
  supportsReasoningEffort?: boolean;
  /** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
  supportsUsageInStreaming?: boolean;
  /** Whether streamed responses include `finish_reason`. When false, pi infers `stop` or `toolUse` when the stream ends. Default: true. */
  supportsFinishReason?: boolean;
  /** Which field to use for max tokens. Default: auto-detected from URL. */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Whether tool results require the `name` field. Default: auto-detected from URL. */
  requiresToolResultName?: boolean;
  /** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
  requiresAssistantAfterToolResult?: boolean;
  /** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
  requiresThinkingAsText?: boolean;
  /** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "deepseek" uses thinking: { type } plus reasoning_effort when supported, "together" uses reasoning: { enabled } plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking: { type }, "qwen" uses top-level enable_thinking: boolean, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking: string, and "ant-ling" uses reasoning: { effort } only when the mapped effort is non-null. Default: "openai". */
  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "baseten"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
  /** Kwargs to send as `chat_template_kwargs` when `thinkingFormat` is `chat-template`. Use `{ "$var": "thinking.enabled" }`, `{ "$var": "thinking.effort" }`, or `{ "$var": "thinking.budget" }` for pi-controlled thinking values. */
  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
  /** Arguments to send as `chat_template_args` when `thinkingFormat` is `baseten`. Use `{ "$var": "thinking.enabled" }`, `{ "$var": "thinking.effort" }`, or `{ "$var": "thinking.budget" }` for pi-controlled thinking values. */
  chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
  /** OpenRouter-compatible routing preferences sent as the `provider` request field. */
  openRouterRouting?: OpenRouterRouting;
  /** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
  vercelGatewayRouting?: VercelGatewayRouting;
  /** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
  zaiToolStream?: boolean;
  /**
   * Top-level request field used to cap reasoning tokens from `thinkingBudgets`.
   * Reasoning and the answer share `max_tokens` on these endpoints, so without a budget a
   * reasoning-heavy turn can consume the whole response and emit no answer.
   * `"thinking_token_budget"` is vLLM, `"thinking_budget"` is Qwen/DashScope/SGLang,
   * `"thinking_budget_tokens"` is llama.cpp. Off by default; not set on the generated catalog.
   */
  thinkingTokenBudgetField?: ThinkingTokenBudgetField;
  /** Alias for `thinkingTokenBudgetField: "thinking_token_budget"` (vLLM). Prefer `thinkingTokenBudgetField`. Default: false. */
  supportsThinkingTokenBudget?: boolean;
  /** Whether the provider supports OpenAI custom tools with Lark/regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. Default: false; the generated model catalog enables it for capable models. */
  supportsOpenAIGrammarTools?: boolean;
  /** Whether the provider supports the `strict` field in tool definitions. Default: true. */
  supportsStrictMode?: boolean;
  /** Cache control convention for prompt caching. "anthropic" applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content. */
  cacheControlFormat?: "anthropic";
  /** Whether to send session-affinity data from `options.sessionId`. Default: false. */
  sendSessionAffinityHeaders?: boolean;
  /** Provider-specific deferred tool serialization mode. */
  deferredToolsMode?: "kimi";
  /** Session-affinity header format: `openai` sends `session_id`, `x-client-request-id`, and `x-session-affinity`; `openai-nosession` sends `x-client-request-id` and `x-session-affinity`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
  sessionAffinityFormat?: SessionAffinityFormat;
  /** Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"` or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. */
  supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat {
  /** Whether the provider supports the `developer` role (vs `system`). Default: true. */
  supportsDeveloperRole?: boolean;
  /** Session-affinity header format: `openai` sends `session_id` and `x-client-request-id`; `openai-nosession` sends `x-client-request-id`; `openrouter` sends `x-session-id`. Does not affect the `prompt_cache_key` body param, which is governed by cache retention. Default: auto-detected. */
  sessionAffinityFormat?: SessionAffinityFormat;
  /** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
  supportsLongCacheRetention?: boolean;
  /** Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly. */
  supportsStrictMode?: boolean;
  /** Whether to emit OpenAI custom tools with Lark/regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. Default: false; the generated model catalog enables it for capable models. */
  supportsOpenAIGrammarTools?: boolean;
  /** Whether the model supports message-anchored `additional_tools` input items. Default: false. */
  supportsAdditionalTools?: boolean;
  /** Whether the model supports client-executed tool search for deferred tools. Default: false. */
  supportsToolSearch?: boolean;
  /** Whether the model accepts `prompt_cache_options` (OpenAI GPT-5.6+ explicit prompt caching). Older OpenAI models reject the parameter. Default: false. */
  supportsExplicitPromptCacheMode?: boolean;
}

/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat {
  /**
   * Whether the provider accepts per-tool `eager_input_streaming`.
   * When false, the Anthropic provider omits `tools[].eager_input_streaming`
   * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
   * for tool-enabled requests.
   * Default: true.
   */
  supportsEagerToolInputStreaming?: boolean;
  /** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
  supportsLongCacheRetention?: boolean;
  /**
   * Whether to send the `x-session-affinity` header from `options.sessionId`
   * when caching is enabled. Required for providers like Fireworks that use
   * session affinity for prompt cache routing (requests to the same replica
   * maximize cache hits).
   * Default: false.
   */
  sendSessionAffinityHeaders?: boolean;
  /**
   * Whether the provider supports Anthropic-style `cache_control` markers on
   * tool definitions. When false, `cache_control` is omitted from tool params.
   * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
   * field on tools and may reject or ignore it.
   * Default: true.
   */
  supportsCacheControlOnTools?: boolean;
  /**
   * Whether the model accepts the Anthropic `temperature` request field.
   * Claude Opus 4.7+ rejects non-default temperature values.
   * Default: true.
   */
  supportsTemperature?: boolean;
  /**
   * Whether to force adaptive thinking (`thinking.type: "adaptive"` plus
   * `output_config.effort`) regardless of the model id. Built-in models that
   * require adaptive thinking set this in generated metadata. Custom
   * Anthropic-compatible providers can set this to `true` for any model whose
   * upstream requires the adaptive format. Set to `false` to
   * opt out on overridden built-in models.
   * Default: false.
   */
  forceAdaptiveThinking?: boolean;
  /** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
  allowEmptySignature?: boolean;
  /** Whether the provider supports Anthropic strict tool schemas. Default: false; generated Anthropic models enable it explicitly. */
  supportsStrictTools?: boolean;
  /**
   * Models Anthropic accepts in `fallbacks` for server-side refusal fallback,
   * with local pricing metadata for returned fallback responses. When absent or
   * empty, callers must omit `fallbacks`; Anthropic rejects the field for models
   * with no permitted fallback targets.
   */
  allowedFallbackModels?: AnthropicAllowedFallbackModel[];
  /**
   * Whether the provider supports deferred tools loaded by `tool_reference`
   * blocks in tool results. Default: true for first-party Anthropic models
   * except Haiku and models older than Claude 4.5; false for other providers.
   */
  supportsToolReferences?: boolean;
}

/** Compatibility settings for Amazon Bedrock models. */
export interface BedrockCompat {
  /** Whether the model supports Bedrock strict tool schemas. Default: false. */
  supportsStrictMode?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * Sent as the `provider` field in the OpenRouter API request body.
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
  /** Whether to allow backup providers to serve requests. Default: true. */
  allow_fallbacks?: boolean;
  /** Whether to filter providers to only those that support all parameters in the request. Default: false. */
  require_parameters?: boolean;
  /** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
  data_collection?: "deny" | "allow";
  /** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
  zdr?: boolean;
  /** Whether to restrict routing to only models that allow text distillation. */
  enforce_distillable_text?: boolean;
  /** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
  order?: string[];
  /** List of provider names/slugs to exclusively allow for this request. */
  only?: string[];
  /** List of provider names/slugs to skip for this request. */
  ignore?: string[];
  /** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
  quantizations?: string[];
  /** Sorting strategy. Can be a string (e.g., "price", "throughput", "latency") or an object with `by` and `partition`. */
  sort?:
    | string
    | {
        /** The sorting metric: "price", "throughput", "latency". */
        by?: string;
        /** Partitioning strategy: "model" (default) or "none". */
        partition?: string | null;
      };
  /** Maximum price per million tokens (USD). */
  max_price?: {
    /** Price per million prompt tokens. */
    prompt?: number | string;
    /** Price per million completion tokens. */
    completion?: number | string;
    /** Price per image. */
    image?: number | string;
    /** Price per audio unit. */
    audio?: number | string;
    /** Price per request. */
    request?: number | string;
  };
  /** Preferred minimum throughput (tokens/second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
  preferred_min_throughput?:
    | number
    | {
        /** Minimum tokens/second at the 50th percentile. */
        p50?: number;
        /** Minimum tokens/second at the 75th percentile. */
        p75?: number;
        /** Minimum tokens/second at the 90th percentile. */
        p90?: number;
        /** Minimum tokens/second at the 99th percentile. */
        p99?: number;
      };
  /** Preferred maximum latency (seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
  preferred_max_latency?:
    | number
    | {
        /** Maximum latency in seconds at the 50th percentile. */
        p50?: number;
        /** Maximum latency in seconds at the 75th percentile. */
        p75?: number;
        /** Maximum latency in seconds at the 90th percentile. */
        p90?: number;
        /** Maximum latency in seconds at the 99th percentile. */
        p99?: number;
      };
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
  /** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
  only?: string[];
  /** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
  order?: string[];
}

// Model interface for the unified model system
export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  reasoning: boolean;
  /**
   * Maps pi thinking levels to provider/model-specific values.
   * Missing keys use provider defaults. null marks a level as unsupported.
   */
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  /** Default sampling parameters for this model. See {@link StreamOptions.samplingParams}; per-request keys override these. */
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
      ? OpenAIResponsesCompat
      : TApi extends "anthropic-messages"
        ? AnthropicMessagesCompat
        : TApi extends "bedrock-converse-stream"
          ? BedrockCompat
          : never;
}
