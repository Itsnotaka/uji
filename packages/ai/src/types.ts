/**
 * Request option and adapter contract types for @uji-ai/ai. The neutral message,
 * model, and tool types live in @uji-ai/schema and are re-exported here so
 * callers that follow pi's layout can import everything from one place; this
 * file adds only what a provider request needs on top of them: transport and
 * auth options, the stream function contract, and the per-API option map.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/types.ts
 * Synced with pi 7ebf9087e.
 */
import type { Api, Context, DeferredHandle, Model, ThinkingLevel } from "@uji-ai/schema";
import type { TelemetryContext } from "@uji-ai/telemetry";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";
export type {
  KnownProvider,
  OpenAICompletionsCompat,
  BedrockCompat,
  OpenRouterRouting,
  VercelGatewayRouting,
  ChatTemplateKwargValue,
  ThinkingTokenBudgetField,
  AnthropicAllowedFallbackModel,
  AnthropicMessagesCompat,
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEvent,
  ConstrainedSamplingConfig,
  Context,
  ProviderCheckpointMaterial,
  DeferredHandle,
  DiagnosticErrorInfo,
  GrammarFormat,
  GrammarVariants,
  ImageContent,
  JsonValue,
  KnownApi,
  Message,
  Model,
  ModelCost,
  ModelCostRates,
  ModelCostTier,
  ModelMode,
  ModelThinkingLevel,
  OpenAIResponsesCompat,
  ProviderId,
  SessionAffinityFormat,
  StopReason,
  TextContent,
  TextSignatureV1,
  ThinkingContent,
  ThinkingLevel,
  ThinkingLevelMap,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@uji-ai/schema";

export type ToolChoice = "auto" | "none";

/** Token budgets for each thinking level (token-based providers only) */
export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";
export type CachedRetention = Exclude<CacheRetention, "none">;

/** Provider-owned lower bounds for prompt-cache lifetime after a confirmed read or write. */
export interface PromptCachePolicy {
  readonly minimumRetentionMs: Readonly<Record<CachedRetention, number>>;
}

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export type FetchFunction = typeof globalThis.fetch;

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}

/** One provider subscription window, normalized as percent consumed. */
export interface AccountLimitWindow {
  /** Stable provider-owned bucket id, for example `five_hour` or `seven_day`. */
  id: string;
  usedPercent: number;
  /** Unix timestamp in milliseconds. */
  resetsAt?: number;
  windowMinutes?: number;
}

/** Ephemeral account-scoped subscription state. Never conversation usage. */
export interface AccountLimits {
  providerId: string;
  plan?: string;
  windows: readonly AccountLimitWindow[];
  /** Unix timestamp in milliseconds when the provider supplied this state. */
  observedAt: number;
}

/** Authentication, HTTP transport, and lifecycle callbacks shared by provider requests. */
export interface ProviderRequestOptions<TModel = Model<Api>> {
  signal?: AbortSignal;
  /** Explicit parent context for telemetry produced by this logical request. */
  telemetryContext?: TelemetryContext;
  apiKey?: string;
  /**
   * Optional fetch implementation for provider HTTP requests.
   * Defaults to `globalThis.fetch`. Provider adapters that cannot inject a custom implementation may reject it.
   * This does not affect WebSocket transports.
   */
  fetch?: FetchFunction;
  /**
   * Provider-scoped environment values. These take precedence over process.env for
   * provider configuration such as regional settings, endpoint placeholders, and
   * proxy variables.
   */
  env?: ProviderEnv;
  /**
   * Optional callback for inspecting or replacing provider payloads before sending.
   * Return undefined to keep the payload unchanged.
   */
  onPayload?: (
    payload: unknown,
    model: TModel,
    // oxlint-disable-next-line no-redundant-type-constituents -- pi's signature: the union documents that undefined means keep the payload, whose shape is the provider's own request body
  ) => unknown | undefined | Promise<unknown | undefined>;
  /**
   * Optional callback invoked after an HTTP response is received.
   */
  onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
  /** Account-limit telemetry observed during a provider request. */
  onAccountLimits?: (limits: AccountLimits, model: TModel) => void | Promise<void>;
  /**
   * Optional custom HTTP headers to include in API requests.
   * Merged with provider defaults; caller values override default headers.
   * A null value suppresses a provider/API default header with the same name.
   */
  headers?: ProviderHeaders;
  /**
   * HTTP request timeout in milliseconds for providers/SDKs that support it.
   * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
   */
  timeoutMs?: number;
  /**
   * Maximum retry attempts for providers/SDKs that support client-side retries.
   * For example, OpenAI and Anthropic SDK clients default to 2.
   */
  maxRetries?: number;
  /**
   * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
   * If the server's requested delay exceeds this value, the request fails immediately
   * with an error containing the requested delay, allowing higher-level retry logic
   * to handle it with user visibility.
   * Default: 60000 (60 seconds). Set to 0 to disable the cap.
   */
  maxRetryDelayMs?: number;
}

export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
  /**
   * Optional callback invoked after an HTTP response is received and before
   * its body stream is consumed.
   */
  onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
  temperature?: number;
  /**
   * Arbitrary sampling parameters merged into the request body as-is, after the named request
   * fields, so keys here override them. Lets custom OpenAI-compatible servers receive parameters
   * Uji does not model, e.g. `top_p`, `top_k`, `min_p`, `repetition_penalty`. Merged over
   * `Model.samplingParams` per key. Only applied by OpenAI-compatible adapters; other APIs ignore it.
   */
  samplingParams?: Record<string, unknown>;
  maxTokens?: number;
  /**
   * Preferred transport for providers that support multiple transports.
   * Providers that do not support this option ignore it.
   */
  transport?: Transport;
  /**
   * Prompt cache retention preference. Providers map this to their supported values.
   * Default: "short".
   */
  cacheRetention?: CacheRetention;
  /**
   * Optional session identifier for providers that support session-based caching.
   * Providers can use this to enable prompt caching, request routing, or other
   * session-aware features. Ignored by providers that don't support it.
   */
  sessionId?: string;
  /**
   * WebSocket connect timeout in milliseconds for providers that support
   * WebSocket transports. This covers the connection/open handshake only;
   * stream idleness after connection uses timeoutMs.
   */
  websocketConnectTimeoutMs?: number;
  /**
   * Optional metadata to include in API requests.
   * Providers extract the fields they understand and ignore the rest.
   * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
   */
  metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
  /**
   * Maximum provider long-poll duration in milliseconds.
   * Defaults to 0, which performs one status check.
   */
  wait?: number;
}

/** Request options for best-effort deferred-response cancellation. */
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * Type-only imports from API implementation modules are erased at emit, so
 * this is tree-shake safe.
 */
export interface ApiOptionsMap {
  "anthropic-messages": AnthropicOptions;
  "google-generative-ai": GoogleOptions;
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
  "openai-codex-responses": OpenAICodexResponsesOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * type; custom API strings fall back to the generic shape.
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
  ? ApiOptionsMap[TApi]
  : StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * under `src/api/` exports `stream` and `streamSimple`; capable modules may also
 * export deferred-response methods. Lazy wrappers (`lazyApi()`) and provider
 * factories pass these around as values. This is the untyped dispatch shape;
 * per-API option typing lives on the implementation modules themselves and on
 * `Provider.stream()` via `ApiStreamOptions`.
 */
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
  fetchDeferred?(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: DeferredFetchOptions,
  ): AssistantMessageEventStream;
  cancelDeferred?(
    model: Model<Api>,
    handle: DeferredHandle,
    options?: DeferredCancelOptions,
  ): Promise<void>;
}

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
  /** Provider-neutral tool selection for simple requests. Default: "auto". */
  toolChoice?: ToolChoice;
  reasoning?: ThinkingLevel;
  /** Request the selected model's advertised fast inference mode. */
  fast?: boolean;
  /** Ask a capable provider to return a durable handle and continue the request asynchronously. */
  deferred?: boolean | { window?: "15m" | "1h" | "24h" };
  /** Custom token budgets for thinking levels (token-based providers only) */
  thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
