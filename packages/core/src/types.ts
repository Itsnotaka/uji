/**
 * Public agent-loop contracts.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/types.ts
 * Synced with pi d4edf066f.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  ProviderCheckpointMaterial,
  Message,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolResultMessage,
  Usage,
} from "@uji-ai/ai";
import { MODEL_THINKING_LEVELS } from "@uji-ai/schema";
import type { JsonValue } from "@uji-ai/schema";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `usage`: if provided, replaces the tool result usage
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content`, `details`, or `usage`.
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  /** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
  usage?: Usage;
}

/** Context passed to `beforeToolCall`. */
export interface BeforeToolCallContext {
  /** The assistant message that requested the tool call. */
  assistantMessage: AssistantMessage;
  /** The raw tool call block from `assistantMessage.content`. */
  toolCall: AgentToolCall;
  /** Validated tool arguments for the target tool schema. */
  args: unknown;
  /** Current agent context at the time the tool call is prepared. */
  context: AgentContext;
}

/** Context passed to `afterToolCall`. */
export interface AfterToolCallContext {
  /** The assistant message that requested the tool call. */
  assistantMessage: AssistantMessage;
  /** The raw tool call block from `assistantMessage.content`. */
  toolCall: AgentToolCall;
  /** Validated tool arguments for the target tool schema. */
  args: unknown;
  /** The executed tool result before any `afterToolCall` overrides are applied. */
  result: AgentToolResult<any>;
  /** Whether the executed tool result is currently treated as an error. */
  isError: boolean;
  /** Current agent context at the time the tool call is finalized. */
  context: AgentContext;
}

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;

  /**
   * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
   *
   * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
   * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
   * status messages) should be filtered out.
   *
   * Contract: must not throw or reject. Return a safe fallback value instead.
   * Throwing interrupts the low-level agent loop without producing a normal event sequence.
   *
   * @example
   * ```typescript
   * convertToLlm: (messages) => messages.flatMap(m => {
   *   if (m.role === "custom") {
   *     // Convert custom message to user message
   *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
   *   }
   *   if (m.role === "notification") {
   *     // Filter out UI-only messages
   *     return [];
   *   }
   *   // Pass through standard LLM messages
   *   return [m];
   * })
   * ```
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  /**
   * Optional transform applied to the context before `convertToLlm`.
   *
   * Use this for operations that work at the AgentMessage level:
   * - Context window management (pruning old messages)
   * - Injecting context from external sources
   *
   * Contract: must not throw or reject. Return the original messages or another
   * safe fallback value instead.
   *
   * @example
   * ```typescript
   * transformContext: async (messages) => {
   *   if (estimateTokens(messages) > MAX_TOKENS) {
   *     return pruneOldMessages(messages);
   *   }
   *   return messages;
   * }
   * ```
   */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  /**
   * Called before a tool is executed, after arguments have been validated.
   *
   * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
   * The hook receives the agent abort signal and is responsible for honoring it.
   */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;

  /**
   * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
   *
   * Return an `AfterToolCallResult` to override parts of the executed tool result:
   * - `content` replaces the full content array
   * - `details` replaces the full details payload
   * - `isError` replaces the error flag
   * - `usage` replaces the tool result usage
   *
   * Any omitted fields keep their original values. No deep merge is performed.
   * The hook receives the agent abort signal and is responsible for honoring it.
   */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it, including "off".
 * Derived from @uji-ai/schema's MODEL_THINKING_LEVELS tuple — the
 * ordered runtime list and both unions live there, not here.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @earendil-works/pi-ai to detect support for a concrete model.
 */
export type ThinkingLevel = ModelThinkingLevel;

/** Whether a stored string is a thinking level this build knows. */
export function isThinkingLevel(value: string): value is ThinkingLevel {
  return MODEL_THINKING_LEVELS.some((level) => level === value);
}

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
  // Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
// oxlint-disable-next-line no-redundant-type-constituents -- upstream extension point resolves to never until declaration-merged
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T> {
  /** Text or image content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: T;
  /** Heading the tool chose for this call, e.g. the path it read. Clients fall back to the tool name. */
  title?: string;
  /** Usage from the final tool execution itself, if available. Not used for main LLM context accounting. */
  usage?: Usage;
  /** Names of tools introduced by this result and available from this transcript point onward. */
  addedToolNames?: string[];
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// ---------------------------------------------------------------------------
// Durable tool wait (design record: "Wait and wake")
// ---------------------------------------------------------------------------

/**
 * Thrown by a tool's `execute` to settle the call as waiting: the runner
 * commits a durable `tool_waiting` record naming the reserved result entry,
 * releases the run's claim, and the run stops consuming any process anywhere.
 * The wake input arrives by ordinary admission; whichever host observes it
 * claims the run and settles the reserved entry exactly once through the
 * tool's `wake` handler.
 *
 * The wait carries nothing. Everything a wake needs is already durable
 * and typed: the intent's schema-validated arguments, the run and call ids,
 * and ids derived from them (the design record's wait invariants). A
 * tool that thinks it must smuggle state across the gap should derive it
 * instead.
 */
const TOOL_WAIT_BRAND = Symbol.for("uji.toolWait");

export class ToolWait {
  /** Shared-symbol brand: `instanceof` fails across duplicated bundles. */
  readonly [TOOL_WAIT_BRAND] = true;
}

export function isToolWait(error: unknown): error is ToolWait {
  // SAFETY: probing the brand symbol on a foreign copy of the class.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[TOOL_WAIT_BRAND] === true
  );
}

/**
 * One waiting call, as the runner hands it to the tool's `wake` handler.
 * `args` are the intent's effective arguments, schema-validated before the
 * intent committed; the tool re-derives its typed view through the same parse
 * `execute` used.
 */
export interface WaitingCall {
  readonly runId: string;
  readonly toolCallId: string;
  readonly resultEntryId: string;
  readonly args: JsonValue;
}

export interface ToolWakeContext {
  readonly signal: AbortSignal;
  /**
   * A durable abort request holds for this run. The handler should settle
   * (its own abort settlement may say more than the generic one); a `wait`
   * outcome is overridden by a generic aborted settlement, because a wait
   * must not outlive an abort.
   */
  readonly aborted: boolean;
  /**
   * The first durable reply recorded for this call (`runs.reply`), if any.
   * Queued conversation messages are never offered to a wake handler.
   */
  readonly reply?: JsonValue;
}

export type ToolWakeOutcome =
  | { kind: "settle"; result: AgentToolResult<unknown>; isError?: boolean }
  | { kind: "wait" };

/**
 * Settle a waiting call on wake, or keep waiting. Runs on whichever host
 * claims the run after wake input arrives, so it derives everything from
 * `wait` and durable state; it holds no memory of the process that
 * waiting. It must not write anything before deciding to settle: a `wait`
 * outcome may be invoked again.
 */
export type ToolWake = (wait: WaitingCall, context: ToolWakeContext) => Promise<ToolWakeOutcome>;

/** Tool definition used by the agent runtime. */
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  /**
   * Optional compatibility shim for raw tool-call arguments before schema validation.
   * Must return an object that matches `TParameters`.
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
  replay?: "never" | "safe";
  /** Settles this tool's waiting calls on wake (design record: "Wait and wake"). */
  wake?: ToolWake;
  /**
   * One line for the system prompt's Available-tools list. A tool without one
   * is still callable; it just goes unmentioned in the prompt (pi's rule).
   */
  promptSnippet?: string;
  /** Guideline bullets this tool contributes to the system prompt's Guidelines section. */
  promptGuidelines?: readonly string[];
}

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
  /** System prompt included with the request. */
  systemPrompt: string;
  /** Provider-native replacement for the history before `messages`. */
  checkpoint?: ProviderCheckpointMaterial;
  /** Transcript visible to the model after the checkpoint, if any. */
  messages: AgentMessage[];
  /** Tools available for this run. */
  tools?: AgentTool<any>[];
}

/**
 * Events one turn emits. The runner settles them into the log; run boundaries
 * are the durable operation records.
 */
export type AgentEvent =
  // Turn lifecycle - a turn is one assistant response + any tool calls/results
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle - emitted for user, assistant, and toolResult messages
  | { type: "message_start"; message: AgentMessage }
  // Only emitted for assistant messages during streaming
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };
