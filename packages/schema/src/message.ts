/**
 * The neutral message model. Every provider adapter translates into and out
 * of these types; the loop, the harness, storage, hooks, and clients never see
 * a provider's own wire. Provider-specific data that must round-trip (an
 * Anthropic thinking signature, an OpenAI reasoning item, a Google thought
 * signature) rides in the opaque `*Signature` fields and is replayed only to
 * the same provider and model.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/types.ts
 * Synced with pi 7ebf9087e.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

import type { Api, ProviderId } from "./model.ts";

export interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}

export interface TextContent {
  type: "text";
  text: string;
  /** Provider message metadata for replay, e.g. an OpenAI message id as TextSignatureV1 JSON. */
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Provider-specific opaque or serialized reasoning replay data. */
  thinkingSignature?: string;
  /**
   * When true, the thinking content was redacted by safety filters. The opaque
   * encrypted payload is stored in `thinkingSignature` so it can be passed back
   * to the API for multi-turn continuity.
   */
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  /** Base64 encoded image data. */
  data: string;
  /** e.g. "image/jpeg", "image/png". */
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  // oxlint-disable-next-line no-explicit-any -- arguments are schema-validated per tool; typed by each tool's TSchema
  arguments: Record<string, any>;
  /** Google-specific: opaque signature for reusing thought context. */
  thoughtSignature?: string;
  /** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
  namespace?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
  cacheWrite1h?: number;
  /**
   * Reasoning/thinking tokens, when the provider reports them. A subset of
   * `output`: `output` already includes these tokens. Set by providers that
   * expose a reasoning breakdown; left undefined by providers that do not.
   */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export interface DeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  /** Provider token, such as a response id or batch id plus row id. */
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  /** Provider conversion data required to reconstruct the final assistant message. */
  data?: JsonValue;
}

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

/** One redacted diagnostic entry. Shape from pi's utils/diagnostics.ts. */
export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: Record<string, unknown>;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  /** Concrete response model when different from the requested `model`. */
  responseModel?: string;
  /** Provider-specific response/message identifier when the upstream API exposes one. */
  responseId?: string;
  /** Redacted provider/runtime diagnostics for failures and recoveries. */
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  /** Provider indication of whether the model explicitly ended its turn. Debugging only. */
  endTurn?: boolean;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}

// oxlint-disable-next-line no-explicit-any -- pi shape; details are tool-defined and typed by each tool
export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  /** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
  usage?: Usage;
  /**
   * Names from `Context.tools` that became available after this result.
   * Providers with native deferred tool loading use this as the load point;
   * other providers ignore it and use `Context.tools` normally.
   */
  addedToolNames?: string[];
  isError: boolean;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * Event protocol for an assistant message stream.
 *
 * Streams emit `start` before partial updates, then terminate with either
 * `done` carrying the final successful AssistantMessage, or `error` carrying
 * the final AssistantMessage with stopReason "error" or "aborted" and an
 * errorMessage. A `*_delta.delta` is incremental and must be appended once;
 * `*_end.content` is authoritative and replaces the accumulated preview.
 * `partial` is one mutable AssistantMessage shared by every event, so clients
 * must not diff successive `partial` references to recover deltas.
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
      message: AssistantMessage;
    }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };
