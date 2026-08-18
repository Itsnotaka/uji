/**
 * Public agent-loop contracts adapted to June's Responses-item wire.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts
 */

import type {
  ResponseItem,
  StopReason,
  StreamDelta,
  ThinkingLevel,
  ToolDefinition,
  ToolResultPart,
  TurnUsage,
} from "@june/schema";

export type {
  StopReason,
  StreamDelta,
  ThinkingLevel,
  ToolResultImagePart,
  ToolResultPart,
  ToolResultTextPart,
  TurnUsage,
} from "@june/schema";

export type AgentMessage = ResponseItem;
export interface ToolResultMessage extends ResponseItem {
  type: "function_call_output";
  call_id: string;
  output: ToolResultPart[];
}

export type ToolExecutionMode = "sequential" | "parallel";

export type QueueMode = "all" | "one-at-a-time";

/** One assistant turn as returned by a stream function. */
export interface AssistantTurn {
  /** Completed output items: reasoning, message, function_call. */
  items: ResponseItem[];
  stopReason: StopReason;
  usage?: TurnUsage;
  errorMessage?: string;
}

/**
 * Stream function used by the agent loop (pi StreamFn contract):
 * - Must not throw or reject for request/model/runtime failures.
 * - Failures are encoded via stopReason "error"/"aborted" plus errorMessage.
 */
export type StreamFn = (context: LlmContext, options: StreamFnOptions) => Promise<AssistantTurn>;

export interface LlmContext {
  systemPrompt: string;
  messages: ResponseItem[];
  tools: ToolDefinition[];
}

export interface StreamFnOptions {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
}

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T = unknown> {
  /** Content returned to the model. */
  content: ToolResultPart[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: T;
  /** Usage from the final tool execution itself. Not used for main model context accounting. */
  usage?: TurnUsage;
  /**
   * Hint that the agent should stop after the current tool batch.
   * Early termination only happens when every finalized tool result in the
   * batch sets this to true.
   */
  terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime (pi AgentTool, June wire). */
export interface AgentTool<TParams = unknown, TDetails = unknown> {
  name: string;
  /** Human-readable label for UI display. */
  label: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  /** Decode, migrate, and validate provider arguments before hooks and execution. */
  prepareArguments: (args: unknown) => TParams;
  /** Execute the tool call. Throw on failure instead of encoding errors in content. */
  execute: (
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** Per-tool execution mode override. */
  executionMode?: ToolExecutionMode;
}

/** A heterogeneous tool value whose parameter and detail types are intentionally erased. */
export type AnyAgentTool = AgentTool<any, any>;

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AnyAgentTool[];
}

/** One function_call item emitted in an assistant turn. */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Result returned from `beforeToolCall`. */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

/** Partial override returned from `afterToolCall`. */
export interface AfterToolCallResult {
  content?: ToolResultPart[];
  details?: unknown;
  isError?: boolean;
  usage?: TurnUsage;
  terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
  assistantMessage: AssistantTurn;
  toolCall: AgentToolCall;
  args: unknown;
  context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
  assistantMessage: AssistantTurn;
  toolCall: AgentToolCall;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn` and `prepareNextTurn`. */
export interface ShouldStopAfterTurnContext {
  message: AssistantTurn;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

/** Replacement runtime state applied before the next provider request. */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentLoopConfig {
  model?: string;
  thinkingLevel?: ThinkingLevel;
  toolExecution?: ToolExecutionMode;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (
    context: ShouldStopAfterTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantTurn; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; delta: StreamDelta }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: string }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: string;
      partialResult: AgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };
