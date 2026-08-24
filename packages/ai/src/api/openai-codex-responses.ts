import type * as NodeZlib from "node:zlib";
import type {
  Tool as OpenAITool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderEnv,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  formatThrownValue,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getUjiUserAgent } from "../utils/uji-user-agent.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
  stripStreamingScratchState,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// ============================================================================
// Wire Decoding
// ============================================================================

/**
 * The fields this adapter acts on in a raw Codex SSE/WebSocket frame. Frames
 * carry more fields; unlisted ones pass through untouched. Decoding happens once
 * at the two ingress points (`parseSSE`, `parseWebSocket`) so downstream code
 * branches on decoded values instead of re-narrowing raw JSON.
 */
interface CodexFrame {
  readonly type: string;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly error?: unknown;
  readonly response?: unknown;
}

interface CodexEventError {
  code?: string;
  message?: string;
}

/** A Codex terminal response status. */
const CodexResponseStatusSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("incomplete"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("queued"),
  Type.Literal("in_progress"),
]);
type CodexResponseStatus = Static<typeof CodexResponseStatusSchema>;

const TextJson = Type.String();
const BooleanJson = Type.Boolean();
const NumberJson = Type.Number();
const JsonObjectJson = Type.Record(Type.String(), Type.Unknown());
const CodexFrameJson = Type.Object({ type: Type.String() });

function textOf(value: unknown): string | undefined {
  return Value.Check(TextJson, value) ? value : undefined;
}

function boolOf(value: unknown): boolean | undefined {
  return Value.Check(BooleanJson, value) ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return Value.Check(NumberJson, value) ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return Value.Check(JsonObjectJson, value) ? value : undefined;
}

/** Returns the frame when its payload decodes, or `undefined` for frames without an event type. */
function decodeCodexFrame(value: unknown): CodexFrame | undefined {
  if (!Value.Check(CodexFrameJson, value)) return undefined;
  return value;
}

function isTerminalResponseType(type: string): boolean {
  return (
    type === "response.completed" || type === "response.done" || type === "response.incomplete"
  );
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  textVerbosity?: "low" | "medium" | "high";
  toolChoice?: "auto" | "none" | "required";
}

interface RequestBody {
  model: string;
  store?: boolean;
  stream?: boolean;
  instructions?: string;
  previous_response_id?: string;
  input?: ResponseInput;
  tools?: OpenAITool[];
  tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
  parallel_tool_calls?: boolean;
  temperature?: number;
  reasoning?: { effort?: string; summary?: string };
  service_tier?: ResponseCreateParamsStreaming["service_tier"];
  text?: { verbosity?: string };
  include?: string[];
  prompt_cache_key?: string;
  [key: string]: unknown;
}

type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

function assertSuccessfulOutput(
  output: AssistantMessage,
): asserts output is SuccessfulAssistantMessage {
  if (output.stopReason === "pending") {
    throw new Error("Codex stream ended without a stop reason");
  }
  if (output.stopReason === "error" || output.stopReason === "aborted") {
    throw new Error(output.errorMessage || "An unknown error occurred");
  }
}

// ============================================================================
// Retry Helpers
// ============================================================================

function isTerminalRateLimitError(errorText: string): boolean {
  return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
    errorText,
  );
}

function isRetryableError(status: number, errorText: string): boolean {
  if (status === 429 && isTerminalRateLimitError(errorText)) {
    return false;
  }
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(
    errorText,
  );
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs !== null) {
    const millis = Number(retryAfterMs);
    if (Number.isFinite(millis)) {
      return Math.max(0, millis);
    }
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

class RetryDelayExceededError extends Error {}

function validateRetryDelayMs(delayMs: number, options?: StreamOptions): number {
  const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
    throw new RetryDelayExceededError(
      `Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
    );
  }
  return delayMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    });
  });
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid timeoutMs: ${String(value)}`);
  }
  return Math.floor(value);
}

// ============================================================================
// Request Compression
// ============================================================================

interface NodeProcessLike {
  versions?: { node?: string; bun?: string };
  getBuiltinModule?: (id: string) => typeof NodeZlib;
}

function nodeProcessLike(): NodeProcessLike | undefined {
  // SAFETY: reads the ambient `process` object structurally so this module also loads in browser builds where it is undefined.
  return (globalThis as { process?: NodeProcessLike }).process;
}

function loadNodeZlib(): typeof NodeZlib | null {
  const proc = nodeProcessLike();
  if (!proc?.versions?.node && !proc?.versions?.bun) {
    return null;
  }
  return proc.getBuiltinModule?.("node:zlib") ?? null;
}

// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
function compressRequestBodyZstd(bodyJson: string): Uint8Array | null {
  const zlib = loadNodeZlib();
  if (!zlib) {
    return null;
  }
  try {
    // A runtime without zstd support throws below and lands in the catch.
    const compressed = zlib.zstdCompressSync(bodyJson, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
    });
    return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  } catch {
    return null;
  }
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-codex-responses",
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }

      const accountId = extractAccountId(apiKey);
      const grammarToolInputProperties = createGrammarToolInputProperties(
        context.tools,
        model.compat?.supportsOpenAIGrammarTools ?? false,
      );
      const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
      const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
      let body = buildRequestBody(
        model,
        context,
        options,
        codexSessionId,
        grammarToolInputProperties,
      );
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody !== undefined) {
        // SAFETY: onPayload's contract is to return this provider's request body (possibly mutated); its signature is unknown because each API defines its own shape.
        body = nextBody as RequestBody;
      }
      const websocketRequestId = codexSessionId || uuidv7();
      const sseHeaders = buildSSEHeaders(
        model.headers,
        options?.headers,
        accountId,
        apiKey,
        codexSessionId,
      );
      const websocketHeaders = buildWebSocketHeaders(
        model.headers,
        options?.headers,
        accountId,
        apiKey,
        websocketRequestId,
      );
      const bodyJson = JSON.stringify(body);
      const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
      const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
      const transport = options?.transport || "auto";
      let startEmitted = false;
      const websocketDisabledForSession =
        transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
      if (websocketDisabledForSession) {
        recordWebSocketSseFallback(cacheSessionId);
      }

      if (transport !== "sse" && !websocketDisabledForSession) {
        let websocketStarted = false;
        let retriedWebSocketConnectionLimit = false;
        let retriedMissingWebSocketContinuation = false;
        while (true) {
          websocketStarted = false;
          try {
            await processWebSocketStream(
              resolveCodexWebSocketUrl(model.baseUrl),
              body,
              websocketHeaders,
              output,
              stream,
              model,
              () => {
                websocketStarted = true;
                if (!startEmitted) {
                  startEmitted = true;
                  stream.push({ type: "start", partial: output });
                }
              },
              httpTimeoutMs,
              websocketConnectTimeoutMs,
              cacheSessionId,
              accountId,
              grammarToolInputProperties,
              options,
            );

            if (options?.signal?.aborted) {
              throw new Error("Request was aborted");
            }
            assertSuccessfulOutput(output);
            stream.push({
              type: "done",
              reason: output.stopReason,
              message: output,
            });
            stream.end();
            return;
          } catch (error) {
            const aborted = options?.signal?.aborted;
            const connectionLimitBeforeStart =
              !websocketStarted && isWebSocketConnectionLimitReachedError(error);
            const previousResponseNotFound = isPreviousResponseNotFoundError(error);
            if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
              retriedMissingWebSocketContinuation = true;
              continue;
            }
            if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
              retriedWebSocketConnectionLimit = true;
              continue;
            }
            if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
              throw error;
            }
            appendAssistantMessageDiagnostic(
              output,
              createAssistantMessageDiagnostic("provider_transport_failure", error, {
                configuredTransport: transport,
                fallbackTransport: websocketStarted ? undefined : "sse",
                eventsEmitted: websocketStarted,
                phase: websocketStarted
                  ? "after_message_stream_start"
                  : "before_message_stream_start",
                requestBytes: new TextEncoder().encode(bodyJson).byteLength,
              }),
            );
            recordWebSocketFailure(cacheSessionId, error);
            if (websocketStarted) {
              throw error;
            }
            recordWebSocketSseFallback(cacheSessionId);
            break;
          }
        }
      }

      // Compress the request body once for the SSE path. The Codex backend
      // decodes Content-Encoding: zstd; the WebSocket transport above sends the
      // uncompressed JSON frame, matching the official Codex client.
      const compressedBody = compressRequestBodyZstd(bodyJson);
      if (compressedBody) {
        sseHeaders.set("content-encoding", "zstd");
      }
      const sseBody: Uint8Array | string = compressedBody ?? bodyJson;

      // Fetch with retry logic for rate limits and transient errors
      let response: Response | undefined;
      let lastError: Error | undefined;
      const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }

        try {
          const headerTimeoutSignal =
            httpTimeoutMs !== undefined && httpTimeoutMs > 0
              ? AbortSignal.timeout(httpTimeoutMs)
              : undefined;
          const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
          try {
            response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
              method: "POST",
              headers: sseHeaders,
              // SAFETY: a zstd-compressed Uint8Array is valid BodyInit at runtime; TS 5.7+ types Buffer as Uint8Array<ArrayBufferLike>, which DOM's BodyInit rejects (Uji divergence).
              body: sseBody as NonNullable<Parameters<typeof fetch>[1]>["body"],
              signal: combinedSignal.signal,
            });
          } catch (error) {
            if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
              throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
            }
            throw error;
          } finally {
            combinedSignal.cleanup();
          }
          await options?.onResponse?.(
            { status: response.status, headers: headersToRecord(response.headers) },
            model,
          );

          if (response.ok) {
            break;
          }

          const errorText = await response.text();
          if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
            const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
            const delayMs =
              retryAfterDelayMs === undefined
                ? BASE_DELAY_MS * 2 ** attempt
                : validateRetryDelayMs(retryAfterDelayMs, options);

            await sleep(delayMs, options?.signal);
            continue;
          }

          // Parse error for friendly message on final attempt or non-retryable error
          const fakeResponse = new Response(errorText, {
            status: response.status,
            statusText: response.statusText,
          });
          const info = await parseErrorResponse(fakeResponse);
          throw new Error(info.friendlyMessage || info.message);
        } catch (error) {
          if (error instanceof Error) {
            if (error.name === "AbortError" || error.message === "Request was aborted") {
              throw new Error("Request was aborted");
            }
          }
          lastError = error instanceof Error ? error : new Error(String(error));
          // Network errors are retryable
          if (
            attempt < maxRetries &&
            !(lastError instanceof RetryDelayExceededError) &&
            !lastError.message.includes("usage limit")
          ) {
            const delayMs = BASE_DELAY_MS * 2 ** attempt;
            await sleep(delayMs, options?.signal);
            continue;
          }
          throw lastError;
        }
      }

      if (!response?.ok) {
        throw lastError ?? new Error("Failed after retries");
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      if (!startEmitted) {
        startEmitted = true;
        stream.push({ type: "start", partial: output });
      }
      await processStream(response, output, stream, model, grammarToolInputProperties, options);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      assertSuccessfulOutput(output);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      stripStreamingScratchState(output.content);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatProviderError(normalizeProviderError(error));
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = {
    ...buildBaseOptions(model, context, options, apiKey),
    toolChoice: options?.toolChoice,
    serviceTier: options?.fast === true ? "priority" : undefined,
  } satisfies OpenAICodexResponsesOptions;
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

  return stream(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

function buildRequestBody(
  model: Model<"openai-codex-responses">,
  context: Context,
  options: OpenAICodexResponsesOptions | undefined,
  cacheSessionId: string | undefined,
  grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
    context.tools,
    model.compat?.supportsOpenAIGrammarTools ?? false,
  ),
): RequestBody {
  const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
  const deferredToolsMode = model.compat?.supportsAdditionalTools
    ? "additional-tools"
    : model.compat?.supportsToolSearch
      ? "tool-search"
      : undefined;
  const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    grammarToolInputProperties,
    deferredTools: toolPlacement.deferred,
    deferredToolsMode,
    toolOptions: {
      strict: null,
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    },
  });

  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    input: messages,
    text: { verbosity: options?.textVerbosity || "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: cacheSessionId,
    tool_choice: options?.toolChoice ?? "auto",
    parallel_tool_calls: true,
  };

  if (options?.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined) {
    body.service_tier = options.serviceTier;
  }

  if (toolPlacement.immediate.length > 0) {
    body.tools = convertResponsesTools(toolPlacement.immediate, {
      strict: null,
      supportsStrictMode,
      supportsOpenAIGrammarTools,
    });
  }

  if (options?.reasoningEffort !== undefined) {
    const effort =
      options.reasoningEffort === "none"
        ? (model.thinkingLevelMap?.off ?? "none")
        : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
    if (effort !== null) {
      body.reasoning = {
        effort,
        summary: options.reasoningSummary ?? "auto",
      };
    }
  }

  return body;
}

function getServiceTierCostMultiplier(
  model: Pick<Model<"openai-codex-responses">, "id">,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model<"openai-codex-responses">, "id">,
) {
  const multiplier = getServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveCodexServiceTier(
  responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
  if (
    responseServiceTier === "default" &&
    (requestServiceTier === "flex" || requestServiceTier === "priority")
  ) {
    return requestServiceTier;
  }
  return responseServiceTier ?? requestServiceTier;
}

function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
  response: Response,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-codex-responses">,
  grammarToolInputProperties: ReadonlyMap<string, string>,
  options?: OpenAICodexResponsesOptions,
): Promise<void> {
  await processResponsesStream(
    mapCodexEvents(parseSSE(response, options?.signal), output),
    output,
    stream,
    model,
    {
      serviceTier: options?.serviceTier,
      grammarToolInputProperties,
      resolveServiceTier: resolveCodexServiceTier,
      applyServiceTierPricing: (usage, serviceTier) =>
        applyServiceTierPricing(usage, serviceTier, model),
    },
  );
}

class CodexApiError extends Error {
  readonly code?: string;
  readonly payload?: unknown;

  constructor(message: string, options?: { code?: string; payload?: unknown; cause?: unknown }) {
    super(message);
    this.name = "CodexApiError";
    this.code = options?.code;
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
    super(message);
    this.name = "CodexProtocolError";
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

function isCodexNonTransportError(cause: unknown): boolean {
  return cause instanceof CodexApiError || cause instanceof CodexProtocolError;
}

function isWebSocketConnectionLimitReachedError(cause: unknown): boolean {
  return cause instanceof CodexApiError && cause.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

function isPreviousResponseNotFoundError(cause: unknown): boolean {
  return cause instanceof CodexApiError && cause.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function extractCodexEventError(event: CodexFrame): CodexEventError {
  const nested = recordOf(event.error);
  return {
    code: textOf(event.code) ?? textOf(nested?.code),
    message: textOf(event.message) ?? textOf(nested?.message),
  };
}

async function* mapCodexEvents(
  events: AsyncIterable<CodexFrame>,
  output: AssistantMessage,
): AsyncGenerator<ResponseStreamEvent> {
  for await (const event of events) {
    const { type } = event;

    if (type === "error") {
      const { code, message } = extractCodexEventError(event);
      throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
        code,
        payload: event,
      });
    }

    if (type === "response.failed") {
      const failure = recordOf(recordOf(event.response)?.error);
      throw new CodexApiError(textOf(failure?.message) || "Codex response failed", {
        code: textOf(failure?.code),
        payload: event,
      });
    }

    if (isTerminalResponseType(type)) {
      const response = recordOf(event.response);
      const endTurn = boolOf(response?.end_turn);
      if (endTurn !== undefined) {
        output.endTurn = endTurn;
      }
      // SAFETY: terminal Codex events are normalized into the OpenAI Responses "response.completed" shape that processResponsesStream consumes; the frame carries the same response fields.
      yield {
        ...event,
        type: "response.completed",
        response: response && {
          ...response,
          status: normalizeCodexStatus(response.status),
        },
      } as ResponseStreamEvent;
      return;
    }

    // SAFETY: non-terminal Codex frames are OpenAI Responses stream events by protocol; they pass through verbatim.
    yield event as ResponseStreamEvent;
  }
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
  return Value.Check(CodexResponseStatusSchema, status) ? status : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<CodexFrame> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try {
              const frame = decodeCodexFrame(JSON.parse(data));
              if (frame) yield frame;
            } catch (cause) {
              throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
                cause,
                payload: data,
              });
            }
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

/** Structural views of the DOM-shaped events runtimes dispatch on sockets. */
interface WebSocketMessageEvent {
  readonly data?: unknown;
}

interface WebSocketErrorEvent {
  readonly message?: unknown;
  readonly error?: unknown;
}

interface WebSocketCloseEvent {
  readonly code?: unknown;
  readonly reason?: unknown;
  readonly wasClean?: unknown;
}

type WebSocketMessageListener = (event: WebSocketMessageEvent) => void;
type WebSocketErrorListener = (event: WebSocketErrorEvent) => void;
type WebSocketCloseListener = (event: WebSocketCloseEvent) => void;

interface WebSocketLike {
  /** Numeric ready state per the WHATWG spec; absent on exotic runtimes. */
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: WebSocketMessageListener): void;
  addEventListener(type: "error", listener: WebSocketErrorListener): void;
  addEventListener(type: "close", listener: WebSocketCloseListener): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "message", listener: WebSocketMessageListener): void;
  removeEventListener(type: "error", listener: WebSocketErrorListener): void;
  removeEventListener(type: "close", listener: WebSocketCloseListener): void;
}

interface CachedWebSocketContinuationState {
  lastRequestBody: RequestBody;
  lastResponseId: string;
  lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
  socket: WebSocketLike;
  busy: boolean;
  createdAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
  requests: number;
  connectionsCreated: number;
  connectionsReused: number;
  cachedContextRequests: number;
  storeTrueRequests: number;
  fullContextRequests: number;
  deltaRequests: number;
  lastInputItems: number;
  lastDeltaInputItems?: number;
  lastPreviousResponseId?: string;
  websocketFailures: number;
  sseFallbacks: number;
  websocketFallbackActive?: boolean;
  lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, Map<string, CachedWebSocketConnection>>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
  let stats = websocketDebugStats.get(sessionId);
  if (!stats) {
    stats = {
      requests: 0,
      connectionsCreated: 0,
      connectionsReused: 0,
      cachedContextRequests: 0,
      storeTrueRequests: 0,
      fullContextRequests: 0,
      deltaRequests: 0,
      lastInputItems: 0,
      websocketFailures: 0,
      sseFallbacks: 0,
    };
    websocketDebugStats.set(sessionId, stats);
  }
  return stats;
}

export function getOpenAICodexWebSocketDebugStats(
  sessionId: string,
): OpenAICodexWebSocketDebugStats | undefined {
  const stats = websocketDebugStats.get(sessionId);
  return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
  if (sessionId) {
    websocketDebugStats.delete(sessionId);
    websocketSseFallbackSessions.delete(sessionId);
    return;
  }
  websocketDebugStats.clear();
  websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
  const closeEntry = (entry: CachedWebSocketConnection) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    closeWebSocketSilently(entry.socket, 1000, "debug_close");
  };
  if (sessionId) {
    for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) closeEntry(entry);
    websocketSessionCache.delete(sessionId);
    return;
  }
  for (const accountEntries of websocketSessionCache.values()) {
    for (const entry of accountEntries.values()) closeEntry(entry);
  }
  websocketSessionCache.clear();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
  return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
  if (!sessionId) return;
  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.sseFallbacks++;
  stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, cause: unknown): void {
  if (!sessionId) return;
  websocketSseFallbackSessions.add(sessionId);

  const stats = getOrCreateWebSocketDebugStats(sessionId);
  stats.websocketFailures++;
  stats.lastWebSocketError = formatThrownValue(cause);
  stats.websocketFallbackActive = true;
}

interface WebSocketConnectOptions {
  headers?: Record<string, string>;
  proxy?: string;
}

type WebSocketConstructor = new (url: string, options?: WebSocketConnectOptions) => WebSocketLike;

let _cachedWebsocket: WebSocketConstructor | null = null;
async function getWebSocketConstructor(env?: ProviderEnv): Promise<WebSocketConstructor | null> {
  if (!env && _cachedWebsocket) return _cachedWebsocket;

  // bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
  // TODO: remove this when bun supports proxy envs in websocket.
  if (nodeProcessLike()?.versions?.bun) {
    const WebSocketWithProxy = class extends WebSocket {
      constructor(url: string | URL, options?: WebSocketConnectOptions) {
        const init: WebSocketConnectOptions = { ...options };
        const proxyUrl = resolveHttpProxyUrlForTarget(
          url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
          env,
        );
        if (proxyUrl) init.proxy = proxyUrl.href;
        // SAFETY: Bun honors undici-style option bags (`proxy`) that its WebSocket typings omit.
        super(url, init as ConstructorParameters<typeof WebSocket>[1]);
      }
    };
    if (!env) {
      _cachedWebsocket = WebSocketWithProxy;
    }
    return WebSocketWithProxy;
  }

  // SAFETY: probes for a WebSocket constructor without assuming a DOM lib; browsers, Node >= 22, and Bun all expose one.
  const ctor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!ctor) return null;
  return ctor;
}

class WebSocketCloseError extends Error {
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;

  constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
    super(message);
    this.name = "WebSocketCloseError";
    this.code = options?.code;
    this.reason = options?.reason;
    this.wasClean = options?.wasClean;
  }
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
  // If readyState is unavailable, assume the runtime keeps it open/reusable.
  return socket.readyState === undefined || socket.readyState === 1;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
  return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {}
}

function scheduleSessionWebSocketExpiry(
  sessionId: string,
  accountId: string,
  entry: CachedWebSocketConnection,
): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
    const accountEntries = websocketSessionCache.get(sessionId);
    if (accountEntries?.get(accountId) === entry) accountEntries.delete(accountId);
    if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
  entry.idleTimer.unref?.();
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
  connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
  env?: ProviderEnv,
): Promise<WebSocketLike> {
  const WebSocketCtor = await getWebSocketConstructor(env);
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }

  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];

  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocketLike;

    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error, closeReason?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (closeReason) {
        closeWebSocketSilently(socket, 1000, closeReason);
      }
      reject(error);
    };
    const onOpen: () => void = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError: WebSocketErrorListener = (event) => {
      fail(extractWebSocketError(event));
    };
    const onClose: WebSocketCloseListener = (event) => {
      fail(extractWebSocketCloseError(event));
    };
    const onAbort = () => {
      fail(new Error("Request was aborted"), "aborted");
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);

    if (connectTimeoutMs > 0) {
      timeout = setTimeout(() => {
        fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
      }, connectTimeoutMs);
    }
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function acquireWebSocket(
  url: string,
  headers: Headers,
  sessionId: string | undefined,
  accountId: string,
  signal?: AbortSignal,
  connectTimeoutMs?: number,
  env?: ProviderEnv,
): Promise<{
  socket: WebSocketLike;
  entry?: CachedWebSocketConnection;
  reused: boolean;
  release: (options?: { keep?: boolean }) => void;
}> {
  if (!sessionId) {
    const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
    return {
      socket,
      reused: false,
      release: () => closeWebSocketSilently(socket),
    };
  }

  let accountEntries = websocketSessionCache.get(sessionId);
  const cached = accountEntries?.get(accountId);
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && isWebSocketSessionExpired(cached)) {
      closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
      accountEntries?.delete(accountId);
      if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
    } else if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        entry: cached,
        reused: true,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            const currentEntries = websocketSessionCache.get(sessionId);
            if (currentEntries?.get(accountId) === cached) currentEntries.delete(accountId);
            if (currentEntries?.size === 0) websocketSessionCache.delete(sessionId);
            return;
          }
          cached.busy = false;
          scheduleSessionWebSocketExpiry(sessionId, accountId, cached);
        },
      };
    }
    if (cached.busy) {
      const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
      return {
        socket,
        reused: false,
        release: () => {
          closeWebSocketSilently(socket);
        },
      };
    }
    if (!isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      accountEntries?.delete(accountId);
      if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
    }
  }

  const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
  const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
  accountEntries = websocketSessionCache.get(sessionId);
  if (!accountEntries) {
    accountEntries = new Map();
    websocketSessionCache.set(sessionId, accountEntries);
  }
  accountEntries.set(accountId, entry);
  return {
    socket,
    entry,
    reused: false,
    release: ({ keep } = {}) => {
      if (!keep || !isWebSocketReusable(entry.socket)) {
        closeWebSocketSilently(entry.socket);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        const currentEntries = websocketSessionCache.get(sessionId);
        if (currentEntries?.get(accountId) === entry) currentEntries.delete(accountId);
        if (currentEntries?.size === 0) websocketSessionCache.delete(sessionId);
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
    },
  };
}

function extractWebSocketError(event: WebSocketErrorEvent): Error {
  const message = textOf(event.message);
  if (message) return new Error(message);

  const nested = event.error;
  if (nested instanceof Error && nested.message.length > 0) return nested;
  const nestedMessage = textOf(recordOf(nested)?.message);
  if (nestedMessage) return new Error(nestedMessage);
  return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: WebSocketCloseEvent): Error {
  const code = numberOf(event.code);
  const reason = textOf(event.reason);
  const codeText = code !== undefined ? ` ${code}` : "";
  const reasonText =
    reason && reason.length > 0
      ? ` ${reason}`
      : code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE
        ? " message too big"
        : "";
  return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
    code,
    reason,
    wasClean: boolOf(event.wasClean),
  });
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
  const text = textOf(data);
  if (text !== undefined) return text;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  const blobLike = recordOf(data);
  if (blobLike && blobLike.arrayBuffer instanceof Function) {
    const arrayBuffer = await blobLike.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}

// Queue events before decoding message data. Blob decoding is asynchronous, so
// decoding inside onMessage lets a following close overtake the terminal frame.
type QueuedWebSocketEvent = { kind: "message"; data: unknown } | { kind: "failure"; error: Error };

async function* parseWebSocket(
  socket: WebSocketLike,
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): AsyncGenerator<CodexFrame> {
  const queue: QueuedWebSocketEvent[] = [];
  let pending: (() => void) | null = null;

  const wake = () => {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    resolve();
  };
  const enqueue = (event: QueuedWebSocketEvent) => {
    queue.push(event);
    wake();
  };

  const onMessage: WebSocketMessageListener = (event) => {
    enqueue({ kind: "message", data: event.data });
  };
  const onError: WebSocketErrorListener = (event) => {
    enqueue({ kind: "failure", error: extractWebSocketError(event) });
  };
  const onClose: WebSocketCloseListener = (event) => {
    enqueue({ kind: "failure", error: extractWebSocketCloseError(event) });
  };
  const onAbort = () => {
    enqueue({ kind: "failure", error: new Error("Request was aborted") });
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (queue.length === 0) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve, reject) => {
          pending = resolve;
          if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
            timeout = setTimeout(() => {
              const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
              pending = null;
              closeWebSocketSilently(socket, 1000, "idle_timeout");
              reject(error);
            }, idleTimeoutMs);
          }
        }).finally(() => {
          if (timeout) {
            clearTimeout(timeout);
          }
        });
      }

      const event = queue.shift();
      if (!event) continue;
      if (event.kind === "failure") {
        throw event.error;
      }

      let text: string | null = null;
      let frame: CodexFrame | undefined;
      try {
        text = await decodeWebSocketData(event.data);
        if (text) frame = decodeCodexFrame(JSON.parse(text));
      } catch (cause) {
        throw new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
          cause,
          payload: text,
        });
      }
      if (!frame) continue;
      const terminal = isTerminalResponseType(frame.type);
      yield frame;
      if (terminal) return;
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
  return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
  body: RequestBody,
  continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
  if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
    return undefined;
  }

  const currentInput = body.input ?? [];
  const baseline = [
    ...(continuation.lastRequestBody.input ?? []),
    ...continuation.lastResponseItems,
  ];
  if (currentInput.length < baseline.length) {
    return undefined;
  }

  const prefix = currentInput.slice(0, baseline.length);
  if (!responseInputsEqual(prefix, baseline)) {
    return undefined;
  }

  return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(
  entry: CachedWebSocketConnection,
  body: RequestBody,
): RequestBody {
  const continuation = entry.continuation;
  if (!continuation) {
    return body;
  }

  const delta = getCachedWebSocketInputDelta(body, continuation);
  if (!delta || !continuation.lastResponseId) {
    entry.continuation = undefined;
    return body;
  }

  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: delta,
  };
}

async function* startWebSocketOutputOnFirstEvent(
  events: AsyncIterable<ResponseStreamEvent>,
  onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
  let started = false;
  for await (const event of events) {
    if (!started) {
      started = true;
      onStart();
    }
    yield event;
  }
}

async function processWebSocketStream(
  url: string,
  body: RequestBody,
  headers: Headers,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-codex-responses">,
  onStart: () => void,
  idleTimeoutMs: number | undefined,
  websocketConnectTimeoutMs: number | undefined,
  cacheSessionId: string | undefined,
  accountId: string,
  grammarToolInputProperties: ReadonlyMap<string, string>,
  options?: OpenAICodexResponsesOptions,
): Promise<void> {
  const { socket, entry, reused, release } = await acquireWebSocket(
    url,
    headers,
    cacheSessionId,
    accountId,
    options?.signal,
    websocketConnectTimeoutMs,
    options?.env,
  );
  let keepConnection = true;
  const useCachedContext =
    options?.transport === "websocket-cached" || options?.transport === "auto";
  // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
  // WebSocket continuation still works via connection-scoped previous_response_id state.
  const fullBody = body;
  const requestBody =
    useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
  const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
  if (stats) {
    stats.requests++;
    if (reused) stats.connectionsReused++;
    else stats.connectionsCreated++;
    if (useCachedContext) stats.cachedContextRequests++;
    if (requestBody.store === true) stats.storeTrueRequests++;
    stats.lastInputItems = requestBody.input?.length ?? 0;
    if (requestBody.previous_response_id) {
      stats.deltaRequests++;
      stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
      stats.lastPreviousResponseId = requestBody.previous_response_id;
    } else {
      stats.fullContextRequests++;
      stats.lastDeltaInputItems = undefined;
      stats.lastPreviousResponseId = undefined;
    }
  }
  try {
    socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    await processResponsesStream(
      startWebSocketOutputOnFirstEvent(
        mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs), output),
        onStart,
      ),
      output,
      stream,
      model,
      {
        serviceTier: options?.serviceTier,
        grammarToolInputProperties,
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) =>
          applyServiceTierPricing(usage, serviceTier, model),
      },
    );
    if (options?.signal?.aborted) {
      keepConnection = false;
    } else if (useCachedContext && entry && output.responseId) {
      const responseItems = convertResponsesMessages(
        model,
        { messages: [output] },
        CODEX_TOOL_CALL_PROVIDERS,
        {
          includeSystemPrompt: false,
          grammarToolInputProperties,
        },
      ).filter(
        (item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output",
      );
      entry.continuation = {
        lastRequestBody: fullBody,
        lastResponseId: output.responseId,
        lastResponseItems: responseItems,
      };
    }
  } catch (error) {
    if (entry) {
      entry.continuation = undefined;
    }
    keepConnection = false;
    throw error;
  } finally {
    release({ keep: keepConnection });
  }
}

// ============================================================================
// Error Handling
// ============================================================================

async function parseErrorResponse(
  response: Response,
): Promise<{ message: string; friendlyMessage?: string }> {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  let friendlyMessage: string | undefined;

  try {
    const body = recordOf(JSON.parse(raw));
    const err = body && recordOf(body.error);
    if (err) {
      const code = textOf(err.code) ?? textOf(err.type) ?? "";
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) ||
        response.status === 429
      ) {
        const planType = textOf(err.plan_type);
        const plan = planType ? ` (${planType.toLowerCase()} plan)` : "";
        const resetsAt = numberOf(err.resets_at);
        const mins = resetsAt
          ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = textOf(err.message) || friendlyMessage || message;
    }
  } catch {}

  return { message, friendlyMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(atob(parts[1]));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("No account ID in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

function buildBaseCodexHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = new Headers(initHeaders);
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    if (value === null) {
      headers.delete(key);
    } else {
      headers.set(key, value);
    }
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "uji");
  headers.set("User-Agent", getUjiUserAgent());
  return headers;
}

function buildSSEHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  sessionId?: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  if (sessionId) {
    headers.set("session-id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }

  return headers;
}

function buildWebSocketHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  requestId: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session-id", requestId);
  return headers;
}
