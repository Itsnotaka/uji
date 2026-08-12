/**
 * Agent loop ported from pi-agent-core's agent-loop.ts, adapted to June's
 * Responses-item wire. Fully standalone: this module knows nothing about
 * sessions, storage, or providers — the stream function and tools are
 * injected. Deleting every other file in this package must not require a
 * change here (pi ch.1 rule: core does not know harness).
 */
import type { ResponseItem, ToolDefinition } from "@june/schema";

/** Reasoning level requested for a turn. "off" omits the reasoning field. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ToolExecutionMode = "sequential" | "parallel";

export type QueueMode = "all" | "one-at-a-time";

export type StopReason = "stop" | "length" | "error" | "aborted";

/** Streaming delta forwarded to `message_update` events. */
export interface StreamDelta {
  kind: "text" | "reasoning";
  text: string;
}

/** Token usage for one assistant step. */
export interface TurnUsage {
  input: number;
  output: number;
  total: number;
}

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
  /** Text returned to the model. */
  content: string;
  /** Arbitrary structured details for logs or UI rendering. */
  details: T;
  /**
   * Hint that the agent should stop after the current tool batch. Early
   * termination only happens when every finalized result in the batch sets it.
   */
  terminate?: boolean;
}

export type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime (pi AgentTool, June wire). */
export interface AgentTool<TParams = unknown, TDetails = unknown> {
  name: string;
  /** Human-readable label for UI display. */
  label: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
  /**
   * Per-tool execution mode override. "sequential" forces the whole batch
   * sequential. Default comes from the loop config.
   */
  executionMode?: ToolExecutionMode;
  /** Execute the tool call. Throw on failure instead of encoding errors in content. */
  execute: (
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

/** Context snapshot passed into the loop. */
export interface AgentContext {
  systemPrompt: string;
  messages: ResponseItem[];
  tools?: AgentTool[];
}

/** The function_call items of one assistant turn. */
export interface AgentToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface AfterToolCallResult {
  content?: string;
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export interface BeforeToolCallContext {
  toolCall: AgentToolCall;
  args: unknown;
  context: AgentContext;
}

export interface AfterToolCallContext {
  toolCall: AgentToolCall;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

export interface ShouldStopAfterTurnContext {
  turn: AssistantTurn;
  toolResults: ResponseItem[];
  context: AgentContext;
  newMessages: ResponseItem[];
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
  /** Default "parallel" (pi default). */
  toolExecution?: ToolExecutionMode;
  /**
   * Optional transform applied to messages before each provider request
   * (context pruning, injection). Must not throw; return a safe fallback.
   */
  transformContext?: (messages: ResponseItem[], signal?: AbortSignal) => Promise<ResponseItem[]>;
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
  /** Steering messages injected after the current turn. Must not throw; return []. */
  getSteeringMessages?: () => Promise<ResponseItem[]>;
  /** Follow-up messages processed after the agent would otherwise stop. Must not throw; return []. */
  getFollowUpMessages?: () => Promise<ResponseItem[]>;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: ResponseItem[] }
  | { type: "turn_start" }
  | { type: "turn_end"; turn: AssistantTurn; toolResults: ResponseItem[] }
  | { type: "message_start"; message: ResponseItem }
  | { type: "message_update"; delta: StreamDelta }
  | { type: "message_end"; message: ResponseItem }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: AgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Start an agent loop with new prompt messages. */
export async function runAgentLoop(
  prompts: ResponseItem[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<ResponseItem[]> {
  const newMessages: ResponseItem[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

/**
 * Continue from the current context without adding a new message (retries).
 * The last message must be user input or a tool result.
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<ResponseItem[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  const last = context.messages[context.messages.length - 1];
  if (last !== undefined && (last.type === "message" || last.type === "reasoning")) {
    throw new Error("Cannot continue from an assistant message");
  }

  const newMessages: ResponseItem[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

function toolCallsOf(turn: AssistantTurn): AgentToolCall[] {
  return turn.items
    .filter((item) => item.type === "function_call" && item.call_id !== undefined)
    .map((item) => ({
      callId: item.call_id as string,
      name: item.name ?? "",
      arguments: item.arguments ?? "{}",
    }));
}

async function runLoop(
  initialContext: AgentContext,
  newMessages: ResponseItem[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn: StreamFn,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  // Check for steering messages at start (user may have typed while waiting)
  let pendingMessages: ResponseItem[] = (await config.getSteeringMessages?.()) ?? [];

  // Outer loop: continues when queued follow-up messages arrive after the agent would stop
  for (;;) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      const turn = await streamAssistantTurn(currentContext, config, signal, emit, streamFn);
      newMessages.push(...turn.items);

      if (turn.stopReason === "error" || turn.stopReason === "aborted") {
        await emit({ type: "turn_end", turn, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = toolCallsOf(turn);
      const toolResults: ResponseItem[] = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        // A "length" stop means the output was cut off by the token limit, so
        // every tool call in the message may carry truncated arguments. Fail
        // them all instead of executing potentially borked calls.
        const batch =
          turn.stopReason === "length"
            ? await failToolCallsFromTruncatedTurn(toolCalls, emit)
            : await executeToolCalls(currentContext, toolCalls, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", turn, toolResults });

      const turnContext: ShouldStopAfterTurnContext = {
        turn,
        toolResults,
        context: currentContext,
        newMessages,
      };
      const update = await config.prepareNextTurn?.(turnContext);
      if (update) {
        currentContext = update.context ?? currentContext;
        config = {
          ...config,
          model: update.model ?? config.model,
          thinkingLevel: update.thinkingLevel ?? config.thinkingLevel,
        };
      }

      if (await config.shouldStopAfterTurn?.(turnContext)) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) ?? [];
    }

    // Agent would stop here. Check for follow-up messages.
    const followUps = (await config.getFollowUpMessages?.()) ?? [];
    if (followUps.length > 0) {
      pendingMessages = followUps;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

async function streamAssistantTurn(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn: StreamFn,
): Promise<AssistantTurn> {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  const deltaEvents: Promise<void>[] = [];
  const turn = await streamFn(
    {
      systemPrompt: context.systemPrompt,
      messages,
      tools: (context.tools ?? []).map(toToolDefinition),
    },
    {
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      signal,
      onDelta: (delta) => {
        deltaEvents.push(Promise.resolve(emit({ type: "message_update", delta })));
      },
    },
  );
  await Promise.all(deltaEvents);

  for (const item of turn.items) {
    context.messages.push(item);
    await emit({ type: "message_start", message: item });
    await emit({ type: "message_end", message: item });
  }
  return turn;
}

function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

function toolResultItem(callId: string, result: AgentToolResult, isError: boolean): ResponseItem {
  const output = isError ? `Error: ${result.content}` : result.content;
  return { type: "function_call_output", call_id: callId, output };
}

interface FinalizedToolCall {
  toolCall: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
}

type FinalizedEntry = FinalizedToolCall | (() => Promise<FinalizedToolCall>);

interface ExecutedToolCallBatch {
  messages: ResponseItem[];
  terminate: boolean;
}

function shouldTerminateToolBatch(finalized: FinalizedToolCall[]): boolean {
  return finalized.length > 0 && finalized.every((f) => f.result.terminate === true);
}

function createErrorToolResult(message: string): AgentToolResult {
  return { content: message, details: {} };
}

async function failToolCallsFromTruncatedTurn(
  toolCalls: AgentToolCall[],
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const messages: ResponseItem[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.callId,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const finalized: FinalizedToolCall = {
      toolCall,
      result: createErrorToolResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(finalized, emit);
    const item = toolResultItem(finalized.toolCall.callId, finalized.result, finalized.isError);
    await emitToolResultMessage(item, emit);
    messages.push(item);
  }
  return { messages, terminate: false };
}

async function executeToolCalls(
  context: AgentContext,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const hasSequential = toolCalls.some(
    (tc) => context.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );
  if (config.toolExecution === "sequential" || hasSequential) {
    return executeSequential(context, toolCalls, config, signal, emit);
  }
  return executeParallel(context, toolCalls, config, signal, emit);
}

async function executeSequential(
  context: AgentContext,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCall[] = [];
  const messages: ResponseItem[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.callId,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(context, toolCall, config, signal);
    let finalized: FinalizedToolCall;
    if (preparation.kind === "immediate") {
      finalized = { toolCall, result: preparation.result, isError: preparation.isError };
    } else {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      finalized = await finalizeExecutedToolCall(context, preparation, executed, config, signal);
    }

    await emitToolExecutionEnd(finalized, emit);
    const item = toolResultItem(finalized.toolCall.callId, finalized.result, finalized.isError);
    await emitToolResultMessage(item, emit);
    finalizedCalls.push(finalized);
    messages.push(item);

    if (signal?.aborted) break;
  }

  return { messages, terminate: shouldTerminateToolBatch(finalizedCalls) };
}

async function executeParallel(
  context: AgentContext,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedEntry[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.callId,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(context, toolCall, config, signal);
    if (preparation.kind === "immediate") {
      const finalized: FinalizedToolCall = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      if (signal?.aborted) break;
      continue;
    }

    finalizedCalls.push(async () => {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(
        context,
        preparation,
        executed,
        config,
        signal,
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
    if (signal?.aborted) break;
  }

  const ordered = await Promise.all(
    finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
  );
  const messages: ResponseItem[] = [];
  for (const finalized of ordered) {
    const item = toolResultItem(finalized.toolCall.callId, finalized.result, finalized.isError);
    await emitToolResultMessage(item, emit);
    messages.push(item);
  }

  return { messages, terminate: shouldTerminateToolBatch(ordered) };
}

interface PreparedToolCall {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown;
}

interface ImmediateOutcome {
  kind: "immediate";
  result: AgentToolResult;
  isError: boolean;
}

interface ExecutedOutcome {
  result: AgentToolResult;
  isError: boolean;
}

async function prepareToolCall(
  context: AgentContext,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateOutcome> {
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (tool === undefined) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    const args: unknown = JSON.parse(toolCall.arguments || "{}");
    if (config.beforeToolCall) {
      const before = await config.beforeToolCall({ toolCall, args, context }, signal);
      if (signal?.aborted) {
        return {
          kind: "immediate",
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        };
      }
      if (before?.block === true) {
        const result = createErrorToolResult(before.reason ?? "Tool execution was blocked");
        if (before.terminate === true) result.terminate = true;
        return { kind: "immediate", result, isError: true };
      }
    }
    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return { kind: "prepared", toolCall, tool, args };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedOutcome> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.callId,
      prepared.args,
      signal,
      (partialResult) => {
        if (!acceptingUpdates) return;
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.callId,
              toolName: prepared.toolCall.name,
              args: prepared.args,
              partialResult,
            }),
          ),
        );
      },
    );
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}

async function finalizeExecutedToolCall(
  context: AgentContext,
  prepared: PreparedToolCall,
  executed: ExecutedOutcome,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCall> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const after = await config.afterToolCall(
        { toolCall: prepared.toolCall, args: prepared.args, result, isError, context },
        signal,
      );
      if (after) {
        result = {
          ...result,
          content: after.content ?? result.content,
          details: after.details ?? result.details,
          terminate: after.terminate ?? result.terminate,
        };
        isError = after.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCall,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.callId,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

async function emitToolResultMessage(item: ResponseItem, emit: AgentEventSink): Promise<void> {
  await emit({ type: "message_start", message: item });
  await emit({ type: "message_end", message: item });
}
