/**
 * Stateless durable runner extracted from AgentHarness. Each invocation reads
 * its continuation state from the session log and keeps only step-local maps.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/agent-harness.ts
 * and https://github.com/earendil-works/pi/blob/dev/packages/coding-agent/src/core/agent-session.ts
 */
import type { SimpleStreamOptions } from "@uji-ai/ai/types";
import { createAssistantMessageEventStream } from "@uji-ai/ai/utils/event-stream";
import { isContextOverflow, isRecoverableLength } from "@uji-ai/ai/utils/overflow";
import type { RetryPolicy } from "@uji-ai/ai/utils/retry";
import { validateToolArguments } from "@uji-ai/ai/utils/validation";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  Usage,
} from "@uji-ai/schema";
import { runAgentLoopContinue } from "../agent-loop.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  QueueMode,
  StreamFn,
  ThinkingLevel,
  ToolExecutionMode,
} from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import type {
  CompactionReason,
  HarnessEvent,
  HarnessTool,
  PendingQueueItem,
} from "./agent-harness.ts";
import {
  compact as compactSession,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type CompactionPreparation,
  type CompactionSettings,
} from "./compaction/compaction.ts";
import { DEFAULT_RETRY_POLICY } from "./config.ts";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "./context.ts";
import { applyStreamOptionsPatch, type HookModelRef, HookRegistry } from "./hooks.ts";
import { buildSessionContext } from "./session/context.ts";
import type { RunClaim, RunWriter } from "./session/store.ts";
import { newId, SessionError, toJsonValue, type JsonValue } from "./session/types.ts";
import type {
  CompactionEntry,
  CompactionIntent,
  OperationStartedRecord,
  PendingRunWrite,
  RunIntent,
  RunState,
  SessionStorage,
} from "./session/types.ts";
import type { AgentHarnessStreamOptions } from "./types.ts";

const HEAD = "main";

type OperationErrorCode =
  | "claim_lost"
  | "compaction"
  | "harness"
  | "refused"
  | "stream"
  | "summarization_failed";
export type OperationError = {
  [TCode in OperationErrorCode]: { code: TCode; message: string };
}[OperationErrorCode];

export type RunOutcome =
  | { kind: "completed"; leafId: string | null }
  | { kind: "aborted"; leafId: string | null }
  | { kind: "failed"; leafId: string | null; error: OperationError };

export type CompactionOutcome =
  | { kind: "completed"; leafId: string; entry: CompactionEntry }
  | { kind: "aborted"; leafId: string | null }
  | { kind: "failed"; leafId: string | null; error: OperationError };

export type RunnerFinished =
  | { kind: "finished"; operation: "run"; runId: string; outcome: RunOutcome }
  | {
      kind: "finished";
      operation: "compaction";
      runId: string;
      outcome: CompactionOutcome;
    };

export type StepResult =
  | { kind: "continue" }
  | {
      kind: "claimed_elsewhere";
      head: string;
      holder: { runId: string; ownerId: string; expiresAtMs: number };
    }
  | RunnerFinished;

export interface RunnerOptions {
  session: SessionStorage;
  runId: string;
  hooks: HookRegistry;
  streamFn: StreamFn;
  tools: readonly HarnessTool[];
  model: Model<Api>;
  systemPrompt: string;
  emit(event: HarnessEvent): Promise<void>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  streamOptions?: AgentHarnessStreamOptions;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
}

/** Claim and commit one provider turn plus its complete tool batch. */
export async function step(options: RunnerOptions): Promise<StepResult> {
  const state = await options.session.runState(options.runId);
  switch (state.kind) {
    case "missing":
      throw new Error(`Run ${options.runId} does not exist`);
    case "finished":
      return finishedFromRecord(state, await options.session.getLeafId(state.operation.head));
    case "running": {
      const claimed = await options.session.claimRun(state.operation.head, options.runId);
      if (!claimed.ok) {
        return claimedElsewhere({ head: state.operation.head, holder: claimed.holder });
      }
      const current = await options.session.runState(options.runId);
      if (current.kind === "finished") {
        await claimed.writer.release();
        return finishedFromRecord(current, await options.session.getLeafId(current.operation.head));
      }
      if (current.kind === "missing") {
        await claimed.writer.release();
        throw new Error(`Run ${options.runId} disappeared`);
      }
      return executeClaimedStep(options, current, claimed.writer);
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** Hot placement: compose durable steps until one commits a terminal outcome. */
export async function drive(
  options: RunnerOptions,
): Promise<Exclude<StepResult, { kind: "continue" }>> {
  while (true) {
    const result = await step(options);
    switch (result.kind) {
      case "continue":
        continue;
      case "claimed_elsewhere":
      case "finished":
        return result;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }
}

/** Claim an orphan, repair its effect sandwich, then commit its next step. */
export async function resume(options: RunnerOptions): Promise<StepResult> {
  const state = await options.session.runState(options.runId);
  switch (state.kind) {
    case "missing":
      throw new Error(`Run ${options.runId} does not exist`);
    case "finished":
      return finishedFromRecord(state, await options.session.getLeafId(state.operation.head));
    case "running": {
      const claimed = await options.session.claimRun(state.operation.head, options.runId);
      if (!claimed.ok) {
        return claimedElsewhere({ head: state.operation.head, holder: claimed.holder });
      }
      const current = await options.session.runState(options.runId);
      if (current.kind === "finished") {
        await claimed.writer.release();
        return finishedFromRecord(current, await options.session.getLeafId(current.operation.head));
      }
      if (current.kind === "missing") {
        await claimed.writer.release();
        throw new Error(`Run ${options.runId} disappeared`);
      }
      if (current.operation.intent.kind === "run") {
        try {
          await recoverRunOperation(
            options,
            current,
            current.operation,
            current.operation.intent,
            claimed.writer,
          );
        } catch (error) {
          if (isClaimLost(error)) {
            return claimedElsewhereAfterFence({ options, state: current, writer: claimed.writer });
          }
          const outcome: RunOutcome = {
            kind: "failed",
            leafId: await options.session.getLeafId(current.operation.head),
            error: {
              code: "harness",
              message: error instanceof Error ? error.message : String(error),
            },
          };
          await finishOperation(options, claimed.writer, outcome);
          return {
            kind: "finished",
            operation: "run",
            runId: current.operation.id,
            outcome,
          };
        }
      }
      return executeClaimedStep(options, await runningState(options), claimed.writer);
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

async function runningState(
  options: RunnerOptions,
): Promise<Extract<RunState, { kind: "running" }>> {
  const state = await options.session.runState(options.runId);
  if (state.kind !== "running") throw new Error(`Run ${options.runId} is no longer running`);
  return state;
}

function claimedElsewhere({
  head,
  holder,
}: {
  head: string;
  holder: Pick<RunClaim, "runId" | "ownerId" | "expiresAtMs">;
}): Extract<StepResult, { kind: "claimed_elsewhere" }> {
  return {
    kind: "claimed_elsewhere",
    head,
    holder: {
      runId: holder.runId,
      ownerId: holder.ownerId,
      expiresAtMs: holder.expiresAtMs,
    },
  };
}

async function claimedElsewhereAfterFence({
  options,
  state,
  writer,
}: {
  options: RunnerOptions;
  state: Extract<RunState, { kind: "running" }>;
  writer: RunWriter;
}): Promise<Extract<StepResult, { kind: "claimed_elsewhere" }>> {
  const head = state.operation.head;
  const live = await options.session.getLiveClaim(head);
  if (live !== undefined && live.ownerId !== writer.claim.ownerId) {
    return claimedElsewhere({ head, holder: live });
  }
  const log = await options.session.getLog();
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index];
    if (item === undefined || item.kind !== "claim") continue;
    switch (item.event.kind) {
      case "acquired":
      case "renewed":
        if (
          item.event.claim.head === head &&
          item.event.claim.fence > writer.claim.fence &&
          item.event.claim.ownerId !== writer.claim.ownerId
        ) {
          return claimedElsewhere({ head, holder: item.event.claim });
        }
        break;
      case "released":
        break;
      default: {
        const _exhaustive: never = item.event;
        return _exhaustive;
      }
    }
  }
  throw new Error(`Run ${state.operation.id} lost its claim without a successor`);
}

function finishedFromRecord(
  state: Extract<RunState, { kind: "finished" }>,
  leafId: string | null,
): RunnerFinished {
  const record = state.finished;
  const outcome: RunOutcome =
    record.outcome === "failed"
      ? {
          kind: "failed",
          leafId: record.leafId ?? leafId,
          error: normalizeOperationError(record.error),
        }
      : { kind: record.outcome, leafId: record.leafId ?? leafId };
  if (state.operation.intent.kind === "run") {
    return { kind: "finished", operation: "run", runId: state.operation.id, outcome };
  }
  if (outcome.kind === "completed" && state.compaction.kind === "compacted") {
    return {
      kind: "finished",
      operation: "compaction",
      runId: state.operation.id,
      outcome: {
        kind: "completed",
        leafId: state.compaction.entry.id,
        entry: state.compaction.entry,
      },
    };
  }
  if (outcome.kind === "completed") {
    return {
      kind: "finished",
      operation: "compaction",
      runId: state.operation.id,
      outcome: {
        kind: "failed",
        leafId: outcome.leafId,
        error: { code: "compaction", message: "compaction finished without a checkpoint" },
      },
    };
  }
  return { kind: "finished", operation: "compaction", runId: state.operation.id, outcome };
}

async function executeClaimedStep(
  options: RunnerOptions,
  state: Extract<RunState, { kind: "running" }>,
  writer: RunWriter,
): Promise<StepResult> {
  const controller = new AbortController();
  const stopAbortWatch = observeAbortRequests(options, controller);
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  const abortFromClaim = (): void => controller.abort(writer.claimLost.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  writer.claimLost.addEventListener("abort", abortFromClaim, { once: true });
  if (options.signal?.aborted === true) abortFromCaller();
  if (writer.claimLost.aborted) abortFromClaim();

  try {
    switch (state.operation.intent.kind) {
      case "run":
        return await executeRunStep(options, state, writer, controller);
      case "compaction":
        return await executeCompactionStep(
          options,
          state.operation,
          state.operation.intent,
          writer,
          controller,
        );
      default: {
        const _exhaustive: never = state.operation.intent;
        return _exhaustive;
      }
    }
  } catch (error) {
    if (isClaimLost(error)) {
      controller.abort(error);
      return claimedElsewhereAfterFence({ options, state, writer });
    }
    const outcome: RunOutcome = {
      kind: "failed",
      leafId: await options.session.getLeafId(state.operation.head),
      error: { code: "harness", message: error instanceof Error ? error.message : String(error) },
    };
    await finishOperation(options, writer, outcome);
    return state.operation.intent.kind === "run"
      ? { kind: "finished", operation: "run", runId: options.runId, outcome }
      : { kind: "finished", operation: "compaction", runId: options.runId, outcome };
  } finally {
    stopAbortWatch();
    options.signal?.removeEventListener("abort", abortFromCaller);
    writer.claimLost.removeEventListener("abort", abortFromClaim);
  }
}

function observeAbortRequests(options: RunnerOptions, controller: AbortController): () => void {
  const stop = new AbortController();
  void (async () => {
    try {
      for await (const item of options.session.watch({ signal: stop.signal })) {
        if (
          item.kind === "record" &&
          item.record.type === "abort_requested" &&
          item.record.runId === options.runId
        ) {
          controller.abort(new Error(`Abort requested for ${options.runId}`));
          return;
        }
      }
    } catch (error) {
      if (stop.signal.aborted) return;
      await options.emit({
        type: "diagnostic",
        level: "error",
        owner: "abort-watch",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return () => stop.abort();
}

async function recoverRunOperation(
  options: RunnerOptions,
  state: Extract<RunState, { kind: "running" }>,
  operation: OperationStartedRecord,
  intent: RunIntent,
  writer: RunWriter,
): Promise<void> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  const abortFromClaim = (): void => controller.abort(writer.claimLost.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  writer.claimLost.addEventListener("abort", abortFromClaim, { once: true });
  if (options.signal?.aborted === true) abortFromCaller();
  if (writer.claimLost.aborted) abortFromClaim();
  try {
    // Prompt entries that never got appended (crash between record and append).
    for (const provisioned of intent.initialMessages) {
      if ((await options.session.getEntry(provisioned.id)) === undefined) {
        await writer.appendEntry(provisioned);
        await options.emit({ type: "message_start", message: provisioned.message });
        await options.emit({
          type: "message_end",
          message: provisioned.message,
          entryId: provisioned.id,
        });
      }
    }

    // Effect sandwich settlement: tool intents without their settlement entry.
    for (const toolIntent of state.unsettledToolIntents) {
      const tool = options.tools.find((candidate) => candidate.name === toolIntent.toolName);
      let output: (TextContent | ImageContent)[];
      let usage: Usage | undefined;
      let isError: boolean;
      if (toolIntent.replay === "safe" && tool !== undefined) {
        try {
          const result = await tool.execute(
            toolIntent.toolCallId,
            toolIntent.effectiveArgs,
            controller.signal,
          );
          output = result.content;
          usage = result.usage;
          isError = false;
        } catch (error) {
          output = toolResultContent(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          isError = true;
        }
      } else {
        output = toolResultContent(
          `Error: tool call "${toolIntent.toolName}" was interrupted before completing and was not ` +
            "replayed. Re-issue it if the work is still needed.",
        );
        isError = true;
      }
      if (usage !== undefined) {
        await writer.appendRecord({
          type: "usage",
          id: newId("r"),
          head: operation.head,
          runId: operation.id,
          cause: "tool",
          usage,
        });
      }
      const message: AgentMessage = {
        role: "toolResult",
        toolCallId: toolIntent.toolCallId,
        toolName: toolIntent.toolName,
        content: output,
        isError,
        timestamp: Date.now(),
      };
      await writer.appendEntry({
        type: "message",
        id: toolIntent.resultEntryId,
        message,
      });
      await options.emit({ type: "message_start", message });
      await options.emit({ type: "message_end", message, entryId: toolIntent.resultEntryId });
    }

    const recoveryBranch = await options.session.getBranch(operation.head);
    const settledToolCalls = new Set<string>();
    for (const entry of recoveryBranch) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        settledToolCalls.add(entry.message.toolCallId);
      }
    }
    const startedToolCalls = new Set(state.toolIntents.map((toolIntent) => toolIntent.toolCallId));
    for (const entry of recoveryBranch) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const content of entry.message.content) {
        if (
          content.type !== "toolCall" ||
          settledToolCalls.has(content.id) ||
          startedToolCalls.has(content.id)
        ) {
          continue;
        }
        await recoverUnstartedToolCall(options, content, controller, writer);
        settledToolCalls.add(content.id);
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller);
    writer.claimLost.removeEventListener("abort", abortFromClaim);
  }
}

/** Recover a tool call whose assistant entry committed before its effect intent did. */
async function recoverUnstartedToolCall(
  options: RunnerOptions,
  toolCall: AgentToolCall,
  controller: AbortController,
  writer: RunWriter,
): Promise<void> {
  const resultEntryId = newId("e");
  await options.emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
    entryId: resultEntryId,
  });

  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  let executableTool: HarnessTool | undefined;
  let effectiveArgs: Record<string, JsonValue> | undefined;
  let result: AgentToolResult<unknown> | undefined;
  let isError = false;
  let effectStarted = false;
  const updateCommits: Promise<void>[] = [];

  try {
    const tool = options.tools.find((candidate) => candidate.name === toolCall.name);
    if (tool === undefined) throw new Error(`Tool ${toolCall.name} not found`);
    const preparedArguments = tool.prepareArguments?.(toolCall.arguments) ?? toolCall.arguments;
    const validated = validateToolArguments(tool, { ...toolCall, arguments: preparedArguments });
    effectiveArgs = toolArguments(toolCall.name, validated);
    let blocked: { reason: string; terminate?: boolean } | undefined;
    if (options.hooks.has("before_tool")) {
      const decision = await options.hooks.run(
        "before_tool",
        {
          head: HEAD,
          runId: options.runId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: effectiveArgs,
        },
        context,
      );
      blocked = decision?.block;
      if (decision?.args !== undefined) effectiveArgs = decision.args;
    }
    if (blocked !== undefined) {
      result = {
        content: toolResultContent(blocked.reason),
        details: {},
        ...(blocked.terminate === undefined ? {} : { terminate: blocked.terminate }),
      };
      isError = true;
    } else {
      executableTool = tool;
    }
  } catch (error) {
    result = {
      content: toolResultContent(error instanceof Error ? error.message : String(error)),
      details: {},
    };
    isError = true;
  }

  if (result === undefined) {
    if (executableTool === undefined || effectiveArgs === undefined) {
      throw new Error(`Tool recovery preparation did not settle ${toolCall.id}`);
    }
    await writer.appendRecord({
      type: "tool_started",
      id: newId("r"),
      head: HEAD,
      runId: options.runId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      effectiveArgs,
      resultEntryId,
      replay: executableTool.replay ?? "never",
    });
    effectStarted = true;
    try {
      result = await executableTool.execute(
        toolCall.id,
        effectiveArgs,
        controller.signal,
        (partialResult) => {
          updateCommits.push(
            options.emit({
              type: "tool_execution_update",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: toolCall.arguments,
              partialResult,
              entryId: resultEntryId,
            }),
          );
        },
      );
    } catch (error) {
      result = {
        content: toolResultContent(error instanceof Error ? error.message : String(error)),
        details: {},
      };
      isError = true;
    }
  }
  await Promise.all(updateCommits);

  if (effectStarted && effectiveArgs !== undefined && options.hooks.has("after_tool")) {
    const patch = await options.hooks.run(
      "after_tool",
      {
        head: HEAD,
        runId: options.runId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: effectiveArgs,
        content: result.content,
        details: toJsonValue(result.details),
        isError,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      },
      context,
    );
    if (patch !== undefined) {
      result = {
        ...result,
        ...(patch.content === undefined ? {} : { content: patch.content }),
        ...(patch.details === undefined ? {} : { details: patch.details }),
        ...(patch.usage === undefined ? {} : { usage: patch.usage }),
        ...(patch.terminate === undefined ? {} : { terminate: patch.terminate }),
      };
      isError = patch.isError ?? isError;
    }
  }

  if (result.usage !== undefined) {
    await writer.appendRecord({
      type: "usage",
      id: newId("r"),
      head: HEAD,
      runId: options.runId,
      cause: "tool",
      usage: result.usage,
    });
  }
  await options.emit({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError,
    entryId: resultEntryId,
  });
  const message: AgentMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content ?? [],
    details: result.details,
    usage: result.usage,
    ...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
    isError,
    timestamp: Date.now(),
  };
  await writer.appendEntry({ type: "message", id: resultEntryId, message });
  await options.emit({ type: "message_start", message });
  await options.emit({ type: "message_end", message, entryId: resultEntryId });
}

async function executeRunStep(
  options: RunnerOptions,
  initialState: Extract<RunState, { kind: "running" }>,
  writer: RunWriter,
  controller: AbortController,
): Promise<StepResult> {
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  if (initialState.abortRequested !== undefined || controller.signal.aborted) {
    const outcome: RunOutcome = {
      kind: "aborted",
      leafId: await options.session.getLeafId(initialState.operation.head),
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "run", runId: options.runId, outcome };
  }

  const refused =
    initialState.retryCount === 0 ? await beforeDrive(options, "run", context) : undefined;
  if (refused !== undefined) {
    const outcome: RunOutcome = {
      kind: "failed",
      leafId: await options.session.getLeafId(initialState.operation.head),
      error: { code: "refused", message: refused },
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "run", runId: options.runId, outcome };
  }

  await drainWrites(options, writer, initialState.retryCount === 0 ? "checkpoint" : "deferred");
  let messages = buildSessionContext(await options.session.getBranch(initialState.operation.head));
  const initialTail = messages.at(-1);
  if (initialTail?.role !== "user" && initialTail?.role !== "toolResult") {
    await drainWrites(options, writer, "checkpoint");
    messages = buildSessionContext(await options.session.getBranch(initialState.operation.head));
  }
  const previousAssistant = findLastAssistant(messages);
  if (previousAssistant !== undefined) {
    const compacted = await compactForThreshold(
      options,
      writer,
      previousAssistant,
      controller.signal,
    );
    if (compacted !== undefined) {
      messages = buildSessionContext(await options.session.getBranch(initialState.operation.head));
    }
  }

  if (initialState.retryCount === 0 && options.hooks.has("before_run")) {
    const result = await options.hooks.run(
      "before_run",
      { head: HEAD, runId: options.runId, prompt: messages, resources: {} },
      context,
    );
    let injected = false;
    for (const message of result?.messages ?? []) {
      if (await appendInjected(options, writer, message)) injected = true;
      else {
        await options.emit({
          type: "diagnostic",
          level: "warn",
          owner: "before_run",
          message: `dropped a ${message.role} message; only provider messages can be injected`,
        });
      }
    }
    if (injected) messages = buildSessionContext(await options.session.getBranch(HEAD));
  }

  const projectedTail = messages.at(-1);
  if (
    projectedTail === undefined ||
    (projectedTail.role !== "user" && projectedTail.role !== "toolResult")
  ) {
    const outcome: RunOutcome = {
      kind: "completed",
      leafId: await options.session.getLeafId(initialState.operation.head),
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "run", runId: options.runId, outcome };
  }

  const turn = await runProviderTurn(
    options,
    writer,
    messages,
    initialState.retryCount,
    controller,
  );
  if (turn.lastTurn === undefined) {
    const outcome: RunOutcome = {
      kind: "failed",
      leafId: await options.session.getLeafId(initialState.operation.head),
      error: { code: "harness", message: "provider turn produced no assistant message" },
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "run", runId: options.runId, outcome };
  }

  if (turn.lastTurn.stopReason !== "aborted") {
    const overflow = isOverflowOrRecoverableLength(options, turn.lastTurn);
    if (overflow) {
      const willRetry = turn.lastTurn.stopReason !== "stop";
      const compacted = initialState.compaction.overflowRecovered
        ? undefined
        : await runAutomaticCompaction(options, writer, "overflow", controller.signal);
      if (willRetry && compacted?.kind === "completed" && !controller.signal.aborted) {
        await writer.release();
        return { kind: "continue" };
      }
    } else {
      await compactForThreshold(options, writer, turn.lastTurn, controller.signal);
    }
  }

  if (turn.lastTurn.stopReason === "aborted" || turn.lastTurn.stopReason === "error") {
    const leafId = await options.session.getLeafId(HEAD);
    const outcome: RunOutcome =
      turn.lastTurn.stopReason === "aborted"
        ? { kind: "aborted", leafId }
        : {
            kind: "failed",
            leafId,
            error: { code: "stream", message: turn.lastTurn.errorMessage ?? "run failed" },
          };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "run", runId: options.runId, outcome };
  }

  await drainWrites(options, writer, "checkpoint");
  if (
    turn.lastTurn.stopReason === "stop" &&
    !controller.signal.aborted &&
    options.hooks.has("before_run_end")
  ) {
    const result = await options.hooks.run(
      "before_run_end",
      {
        head: HEAD,
        runId: options.runId,
        messages: buildSessionContext(await options.session.getBranch(HEAD)),
      },
      context,
    );
    if (result?.followUp !== undefined) {
      await appendInjected(options, writer, {
        role: "user",
        content: result.followUp,
        timestamp: Date.now(),
      });
      await writer.release();
      return { kind: "continue" };
    }
  }

  const afterCheckpoint = await runningState(options);
  const branch = buildSessionContext(await options.session.getBranch(HEAD));
  const tail = branch.at(-1);
  const hasContinuableTail = tail?.role === "user" || tail?.role === "toolResult";
  const toolCalls = turn.lastTurn.content.filter((content) => content.type === "toolCall");
  const toolBatchContinues = toolCalls.length > 0 && !turn.toolBatchTerminated;
  if (toolBatchContinues || hasContinuableTail || hasPendingSteer(afterCheckpoint)) {
    await writer.release();
    return { kind: "continue" };
  }

  const followUps =
    initialState.operation.intent.kind === "run" &&
    initialState.operation.intent.promotionScope === "steer"
      ? 0
      : await drainWrites(options, writer, "followUp");
  if (followUps > 0) {
    await writer.release();
    return { kind: "continue" };
  }

  const leafId = await options.session.getLeafId(HEAD);
  const outcome: RunOutcome = { kind: "completed", leafId };
  await finishOperation(options, writer, outcome);
  return { kind: "finished", operation: "run", runId: options.runId, outcome };
}

function hasPendingSteer(state: Extract<RunState, { kind: "running" }>): boolean {
  return state.pendingWrites.some(
    (pending) => pending.kind === "deferred" || pending.kind === "steer",
  );
}

async function drainWrites(
  options: RunnerOptions,
  writer: RunWriter,
  phase: "checkpoint" | "deferred" | "followUp",
): Promise<number> {
  const state = await runningState(options);
  const selected: PendingRunWrite[] = [];
  let steers = 0;
  let followUps = 0;
  for (const pending of state.pendingWrites) {
    switch (pending.kind) {
      case "deferred":
        if (phase !== "followUp") selected.push(pending);
        break;
      case "nextRun":
      case "steer":
        if (phase === "checkpoint" && (options.steeringMode === "all" || steers === 0)) {
          selected.push(pending);
          steers += 1;
        }
        break;
      case "followUp":
        if (phase === "followUp" && (options.followUpMode === "all" || followUps === 0)) {
          selected.push(pending);
          followUps += 1;
        }
        break;
      default: {
        const _exhaustive: never = pending;
        void _exhaustive;
      }
    }
  }

  for (const pending of selected) {
    const entry = await writer.appendEntry(pending.record.target);
    if (entry.type === "message") {
      await options.emit({ type: "message_start", message: entry.message });
      await options.emit({ type: "message_end", message: entry.message, entryId: entry.id });
    }
  }
  if (selected.some((pending) => pending.kind !== "deferred")) {
    await options.emit({ type: "queue_update", items: await pendingQueueItems(options) });
  }
  return selected.length;
}

async function pendingQueueItems(options: RunnerOptions): Promise<PendingQueueItem[]> {
  const state = await options.session.runState(options.runId);
  if (state.kind === "missing") return [];
  return state.pendingWrites.flatMap((pending): PendingQueueItem[] => {
    switch (pending.kind) {
      case "deferred":
        return [];
      case "followUp":
        return [
          {
            entryId: pending.record.target.id,
            delivery: "queue",
            message: pending.record.target.message,
          },
        ];
      case "nextRun":
        return [
          {
            entryId: pending.record.target.id,
            delivery: "nextRun",
            message: pending.record.target.message,
          },
        ];
      case "steer":
        return [
          {
            entryId: pending.record.target.id,
            delivery: "steer",
            message: pending.record.target.message,
          },
        ];
      default: {
        const _exhaustive: never = pending;
        return _exhaustive;
      }
    }
  });
}

interface ProviderTurn {
  lastTurn: AssistantMessage | undefined;
  toolBatchTerminated: boolean;
}

async function runProviderTurn(
  options: RunnerOptions,
  writer: RunWriter,
  messages: Message[],
  previousAttempt: number,
  controller: AbortController,
): Promise<ProviderTurn> {
  const pendingMessages = new Map<
    AgentMessage,
    { kind: "provisioned"; id: string } | { kind: "existing"; id: string }
  >();
  const toolResultIds = new Map<string, string>();
  const toolTerminations: boolean[] = [];
  let assistantEntryId: string | undefined;
  const clearedArgs = new Map<string, unknown>();
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  const tools = bindTools(options.tools, clearedArgs);
  let currentSystemPrompt = options.systemPrompt;
  let attempt = previousAttempt;
  let lastTurn: AssistantMessage | undefined;
  const baseStream = hookedStream(options, "assistant", () => attempt, context);
  const streamFn: StreamFn = (model, llmContext, streamOptions) =>
    baseStream(model, { ...llmContext, systemPrompt: currentSystemPrompt }, streamOptions);

  const toolResultEntryId = (toolCallId: string): string => {
    const existing = toolResultIds.get(toolCallId);
    if (existing !== undefined) return existing;
    const provisioned = newId("e");
    toolResultIds.set(toolCallId, provisioned);
    return provisioned;
  };

  const emitLoopEvent = async (event: AgentEvent): Promise<void> => {
    // One loop pass per durable step; the harness brackets the whole run.
    if (event.type === "agent_start" || event.type === "agent_end") return;
    let entryId: string | undefined;
    if (event.type === "message_start" && event.message.role === "assistant") {
      assistantEntryId = newId("e");
    } else if (event.type === "turn_start") {
      attempt += 1;
      await writer.appendRecord({
        type: "step_attempt",
        id: newId("r"),
        head: HEAD,
        runId: options.runId,
        step: "assistant",
        attempt,
      });
    } else if (event.type === "turn_end") {
      if (event.message.role !== "assistant") {
        throw new Error("turn_end must carry an assistant message");
      }
      lastTurn = event.message;
      await writer.appendRecord({
        type: "usage",
        id: newId("r"),
        head: HEAD,
        runId: options.runId,
        cause: "assistant",
        usage: event.message.usage,
      });
    } else if (event.type === "tool_execution_end") {
      toolTerminations.push(event.result.terminate === true);
      if (event.result.usage !== undefined) {
        await writer.appendRecord({
          type: "usage",
          id: newId("r"),
          head: HEAD,
          runId: options.runId,
          cause: "tool",
          usage: event.result.usage,
        });
      }
    } else if (event.type === "tool_execution_start") {
      toolResultEntryId(event.toolCallId);
    } else if (event.type === "message_end") {
      const pending = pendingMessages.get(event.message);
      pendingMessages.delete(event.message);
      const id =
        pending?.id ??
        (event.message.role === "assistant" ? assistantEntryId : undefined) ??
        (event.message.role === "toolResult"
          ? toolResultEntryId(event.message.toolCallId)
          : undefined) ??
        newId("e");
      if (pending?.kind !== "existing") {
        await writer.appendEntry({ type: "message", id, message: event.message });
      }
      entryId = id;
      if (event.message.role === "assistant") assistantEntryId = undefined;
      if (pending?.kind === "provisioned") {
        await options.emit({ type: "queue_update", items: [] });
      }
    }
    if (event.type === "message_end") {
      if (entryId === undefined) throw new Error("Completed message was not stored");
      await options.emit({ ...event, entryId });
    } else if (event.type === "message_update") {
      assistantEntryId ??= newId("e");
      await options.emit({ ...event, entryId: assistantEntryId });
    } else if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      await options.emit({ ...event, entryId: toolResultEntryId(event.toolCallId) });
    } else {
      await options.emit(event);
    }
  };

  await runAgentLoopContinue(
    { systemPrompt: options.systemPrompt, messages, tools },
    {
      model: options.model,
      transformContext: async (candidateMessages) => {
        currentSystemPrompt = options.systemPrompt;
        if (!options.hooks.has("transform_context")) return candidateMessages;
        const result = await options.hooks.run(
          "transform_context",
          {
            head: HEAD,
            runId: options.runId,
            messages: candidateMessages,
            systemPrompt: options.systemPrompt,
          },
          context,
        );
        if (result?.systemPrompt !== undefined) currentSystemPrompt = result.systemPrompt;
        return result?.messages ?? candidateMessages;
      },
      convertToLlm: (candidateMessages) =>
        candidateMessages.filter((message): message is Message => isProviderMessage(message)),
      reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
      toolExecution: options.toolExecution,
      shouldStopAfterTurn: () => true,
      prepareNextTurn: async ({ message }) => {
        if (isOverflowOrRecoverableLength(options, message)) return undefined;
        const compacted = await compactForThreshold(options, writer, message, controller.signal);
        if (compacted === undefined) return undefined;
        return {
          context: {
            systemPrompt: options.systemPrompt,
            messages: buildSessionContext(await options.session.getBranch(HEAD)),
            tools,
          },
        };
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const tool = options.tools.find((candidate) => candidate.name === toolCall.name);
        let effectiveArgs = toolArguments(toolCall.name, args);
        if (options.hooks.has("before_tool")) {
          const decision = await options.hooks.run(
            "before_tool",
            {
              head: HEAD,
              runId: options.runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              args: effectiveArgs,
            },
            context,
          );
          if (decision?.block !== undefined) {
            return {
              block: true,
              reason: decision.block.reason,
              ...(decision.block.terminate === undefined
                ? {}
                : { terminate: decision.block.terminate }),
            };
          }
          if (decision?.args !== undefined) {
            effectiveArgs = decision.args;
            clearedArgs.set(toolCall.id, effectiveArgs);
          }
        }
        const resultEntryId = toolResultEntryId(toolCall.id);
        await writer.appendRecord({
          type: "tool_started",
          id: newId("r"),
          head: HEAD,
          runId: options.runId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          effectiveArgs,
          resultEntryId,
          replay: tool?.replay ?? "never",
        });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        clearedArgs.delete(toolCall.id);
        if (!options.hooks.has("after_tool")) return undefined;
        const patch = await options.hooks.run(
          "after_tool",
          {
            head: HEAD,
            runId: options.runId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolArguments(toolCall.name, toolCall.arguments),
            content: result.content,
            details: toJsonValue(result.details),
            isError,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
          },
          context,
        );
        if (patch === undefined) return undefined;
        return {
          ...(patch.content === undefined ? {} : { content: patch.content }),
          ...(patch.details === undefined ? {} : { details: patch.details }),
          ...(patch.isError === undefined ? {} : { isError: patch.isError }),
          ...(patch.usage === undefined ? {} : { usage: patch.usage }),
          ...(patch.terminate === undefined ? {} : { terminate: patch.terminate }),
        };
      },
    },
    emitLoopEvent,
    controller.signal,
    streamFn,
  );
  return {
    lastTurn,
    toolBatchTerminated:
      toolTerminations.length > 0 && toolTerminations.every((terminated) => terminated),
  };
}

function bindTools(
  source: readonly HarnessTool[],
  clearedArgs: ReadonlyMap<string, unknown>,
): HarnessTool[] {
  return source.map((tool) => ({
    ...tool,
    execute: (toolCallId, params, onUpdate, signal) =>
      tool.execute(toolCallId, clearedArgs.get(toolCallId) ?? params, onUpdate, signal),
  }));
}

function hookedStream(
  runner: RunnerOptions,
  stepKind: "assistant" | "compaction",
  attempt: () => number,
  context: Context,
): StreamFn {
  return (model, llmContext, options) => {
    const out = createAssistantMessageEventStream();
    const modelRef: HookModelRef = { provider: model.provider, modelId: model.id };
    void (async () => {
      const sessionId = options?.sessionId ?? (await runner.session.getMetadata()).id;
      let streamOptions: SimpleStreamOptions = {
        ...options,
        sessionId,
      };
      streamOptions = withHarnessStreamOptions(
        streamOptions,
        applyStreamOptionsPatch(runner.streamOptions ?? {}, harnessStreamOptions(streamOptions)),
      );
      if (runner.hooks.has("before_request")) {
        const result = await runner.hooks.run(
          "before_request",
          {
            head: HEAD,
            runId: runner.runId,
            model: modelRef,
            step: stepKind,
            attempt: attempt(),
            streamOptions: harnessStreamOptions(streamOptions),
          },
          context,
        );
        if (result?.streamOptions !== undefined) {
          const patched = applyStreamOptionsPatch(
            harnessStreamOptions(streamOptions),
            result.streamOptions,
          );
          streamOptions = withHarnessStreamOptions(streamOptions, patched);
        }
      }
      if (runner.hooks.has("before_payload")) {
        const previous = streamOptions.onPayload;
        streamOptions.onPayload = async (payload, payloadModel) => {
          const seeded = (await previous?.(payload, payloadModel)) ?? payload;
          const result = await runner.hooks.run(
            "before_payload",
            { head: HEAD, runId: runner.runId, model: modelRef, payload: seeded },
            context,
          );
          return result?.payload ?? seeded;
        };
      }
      const inner = await runner.streamFn(model, llmContext, streamOptions);
      for await (const event of inner) {
        if (
          (event.type === "done" || event.type === "error") &&
          runner.hooks.has("after_response")
        ) {
          const message = event.type === "done" ? event.message : event.error;
          const result = await runner.hooks.run(
            "after_response",
            { head: HEAD, runId: runner.runId, message },
            context,
          );
          const replaced = result?.message ?? message;
          out.push(
            event.type === "done" ? { ...event, message: replaced } : { ...event, error: replaced },
          );
          continue;
        }
        out.push(event);
      }
      out.end();
    })().catch((error: unknown) => {
      out.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
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
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      });
    });
    return out;
  };
}

async function beforeDrive(
  options: RunnerOptions,
  operation: "run" | "compaction",
  context: Context,
): Promise<string | undefined> {
  if (!options.hooks.has("before_drive")) return undefined;
  try {
    await options.hooks.run(
      "before_drive",
      { head: HEAD, runId: options.runId, operation },
      context,
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function appendInjected(
  options: RunnerOptions,
  writer: RunWriter,
  message: AgentMessage,
): Promise<boolean> {
  if (!isProviderMessage(message)) return false;
  const id = newId("e");
  await writer.appendEntry({ type: "message", id, message });
  await options.emit({ type: "message_start", message });
  await options.emit({ type: "message_end", message, entryId: id });
  return true;
}

async function executeCompactionStep(
  options: RunnerOptions,
  operation: OperationStartedRecord,
  intent: CompactionIntent,
  writer: RunWriter,
  controller: AbortController,
): Promise<RunnerFinished> {
  const branch = await options.session.getBranch(operation.head);
  const settled = branch.at(-1);
  if (settled?.type === "compaction" && settled.parentId === operation.sourceLeafId) {
    const outcome: CompactionOutcome = {
      kind: "completed",
      leafId: settled.id,
      entry: settled,
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "compaction", runId: options.runId, outcome };
  }

  const preparation = prepareCompaction(branch, compactionSettings(options));
  if (!preparation.ok || preparation.value === undefined) {
    const outcome: CompactionOutcome = {
      kind: "failed",
      leafId: await options.session.getLeafId(operation.head),
      error: {
        code: "compaction",
        message: preparation.ok ? "nothing to compact" : preparation.error.message,
      },
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "compaction", runId: options.runId, outcome };
  }

  const outcome = await performCompaction(
    options,
    writer,
    preparation.value,
    intent.customInstructions,
    "manual",
    controller.signal,
  );
  await finishOperation(options, writer, outcome);
  return { kind: "finished", operation: "compaction", runId: options.runId, outcome };
}

async function performCompaction(
  options: RunnerOptions,
  writer: RunWriter,
  preparation: CompactionPreparation,
  customInstructions: string | undefined,
  reason: CompactionReason,
  signal: AbortSignal,
): Promise<CompactionOutcome> {
  await options.emit({ type: "compaction_start", runId: options.runId, reason });
  const state = await runningState(options);
  await writer.appendRecord({
    type: "step_attempt",
    id: newId("r"),
    head: HEAD,
    runId: options.runId,
    step: "compaction",
    attempt: state.compaction.attempts + 1,
  });

  try {
    const driveContext = withAbortSignal(signal, BACKGROUND_CONTEXT);
    const refused = await beforeDrive(options, "compaction", driveContext);
    if (refused !== undefined) {
      const error: OperationError = { code: "refused", message: refused };
      await options.emit({
        type: "compaction_end",
        runId: options.runId,
        reason,
        outcome: "failed",
        error,
      });
      return { kind: "failed", leafId: await options.session.getLeafId(HEAD), error };
    }
    const compacted = await compactSession(
      preparation,
      hookedStream(options, "compaction", () => 1, driveContext),
      options.model,
      customInstructions,
      options.thinkingLevel,
      retryPolicy(options),
      undefined,
      signal,
    );
    if (!compacted.ok) {
      const leafId = await options.session.getLeafId(HEAD);
      if (compacted.error.code === "aborted") {
        const outcome: CompactionOutcome = { kind: "aborted", leafId };
        await options.emit({
          type: "compaction_end",
          runId: options.runId,
          reason,
          outcome: "aborted",
        });
        return outcome;
      }
      const error: OperationError = {
        code: compacted.error.code,
        message: compacted.error.message,
      };
      const outcome: CompactionOutcome = { kind: "failed", leafId, error };
      await options.emit({
        type: "compaction_end",
        runId: options.runId,
        reason,
        outcome: "failed",
        error,
      });
      return outcome;
    }

    if (signal.aborted) {
      const leafId = await options.session.getLeafId(HEAD);
      const outcome: CompactionOutcome = { kind: "aborted", leafId };
      await options.emit({
        type: "compaction_end",
        runId: options.runId,
        reason,
        outcome: "aborted",
      });
      return outcome;
    }

    const value = compacted.value;
    const saved = await writer.appendEntry({
      type: "compaction",
      id: newId("e"),
      summary: value.summary,
      retainedTail: value.retainedTail,
      tokensBefore: value.tokensBefore,
      ...(value.details === undefined ? {} : { details: toJsonValue(value.details) }),
      ...(value.usage === undefined ? {} : { usage: value.usage }),
      fromHook: false,
      reason,
    });
    if (saved.type !== "compaction") {
      throw new Error(`Expected a compaction entry, received ${saved.type}`);
    }
    if (value.usage !== undefined) {
      await writer.appendRecord({
        type: "usage",
        id: newId("r"),
        head: HEAD,
        runId: options.runId,
        cause: "compaction",
        usage: value.usage,
      });
    }

    const outcome: CompactionOutcome = { kind: "completed", leafId: saved.id, entry: saved };
    await options.emit({
      type: "compaction_end",
      runId: options.runId,
      reason,
      outcome: "completed",
      entry: saved,
      fromHook: false,
    });
    return outcome;
  } catch (cause) {
    if (isClaimLost(cause)) throw cause;
    const leafId = await options.session.getLeafId(HEAD);
    const error: OperationError = {
      code: "compaction",
      message: cause instanceof Error ? cause.message : String(cause),
    };
    const outcome: CompactionOutcome = { kind: "failed", leafId, error };
    await options.emit({
      type: "compaction_end",
      runId: options.runId,
      reason,
      outcome: "failed",
      error,
    });
    return outcome;
  }
}

async function compactForThreshold(
  options: RunnerOptions,
  writer: RunWriter,
  assistantMessage: AssistantMessage,
  signal: AbortSignal,
): Promise<CompactionEntry | undefined> {
  const settings = compactionSettings(options);
  if (!settings.enabled || assistantMessage.stopReason === "aborted" || signal.aborted) {
    return undefined;
  }

  const branch = await options.session.getBranch(HEAD);
  const state = await runningState(options);
  const latestCompaction =
    state.compaction.kind === "compacted" ? state.compaction.entry : undefined;
  if (latestCompaction !== undefined && assistantMessage.timestamp <= latestCompaction.timestamp) {
    return undefined;
  }

  const directContextTokens = calculateContextTokens(assistantMessage.usage);
  let contextTokens = directContextTokens;
  if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
    const messages = buildSessionContext(branch);
    const estimate = estimateContextTokens(messages);
    if (estimate.lastUsageIndex !== null && latestCompaction !== undefined) {
      const usageMessage = messages[estimate.lastUsageIndex];
      if (
        usageMessage?.role === "assistant" &&
        usageMessage.timestamp <= latestCompaction.timestamp
      ) {
        return undefined;
      }
    }
    contextTokens = estimate.tokens;
  }

  if (!shouldCompact(contextTokens, options.model.contextWindow, settings)) return undefined;
  const outcome = await runAutomaticCompaction(options, writer, "threshold", signal);
  return outcome?.kind === "completed" ? outcome.entry : undefined;
}

async function runAutomaticCompaction(
  options: RunnerOptions,
  writer: RunWriter,
  reason: Exclude<CompactionReason, "manual">,
  signal: AbortSignal,
): Promise<CompactionOutcome | undefined> {
  if (!compactionSettings(options).enabled || signal.aborted) return undefined;
  const preparation = prepareCompaction(
    await options.session.getBranch(HEAD),
    compactionSettings(options),
  );
  if (!preparation.ok || preparation.value === undefined) return undefined;
  return performCompaction(options, writer, preparation.value, undefined, reason, signal);
}

async function finishOperation(
  options: RunnerOptions,
  writer: RunWriter,
  outcome: RunOutcome | CompactionOutcome,
): Promise<void> {
  const finished = await writer.finish({
    type: "operation_finished",
    id: newId("r"),
    head: HEAD,
    runId: options.runId,
    outcome: outcome.kind,
    leafId: outcome.leafId,
    ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
  });
  for (const entry of finished.deferredEntries) {
    if (entry.type !== "message") continue;
    await options.emit({ type: "message_start", message: entry.message });
    await options.emit({ type: "message_end", message: entry.message, entryId: entry.id });
  }
}

function compactionSettings(options: RunnerOptions): CompactionSettings {
  return options.compaction ?? DEFAULT_COMPACTION_SETTINGS;
}

function retryPolicy(options: RunnerOptions): RetryPolicy {
  return options.retry ?? DEFAULT_RETRY_POLICY;
}

function isOverflowOrRecoverableLength(options: RunnerOptions, message: AssistantMessage): boolean {
  const sameModel =
    message.provider === options.model.provider && message.model === options.model.id;
  return (
    sameModel &&
    (isContextOverflow(message, options.model.contextWindow) ||
      isRecoverableLength(message, options.model.maxTokens))
  );
}

function isClaimLost(error: unknown): error is SessionError {
  return error instanceof SessionError && error.code === "claim_lost";
}

function normalizeOperationError(
  error: { code: string; message: string } | undefined,
): OperationError {
  if (error === undefined) return { code: "harness", message: "run failed" };
  switch (error.code) {
    case "claim_lost":
    case "compaction":
    case "harness":
    case "refused":
    case "stream":
    case "summarization_failed":
      return { code: error.code, message: error.message };
    default:
      return { code: "harness", message: error.message };
  }
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolArguments(toolName: string, args: unknown): Record<string, JsonValue> {
  const json = toJsonValue(args);
  if (!isJsonObject(json)) throw new Error(`tool ${toolName} received non-object arguments`);
  return json;
}

function isProviderMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function findLastAssistant(messages: readonly Message[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

const HARNESS_STREAM_OPTION_KEYS = [
  "maxRetries",
  "maxRetryDelayMs",
  "transport",
  "cacheRetention",
  "fast",
  "temperature",
  "maxTokens",
  "headers",
  "samplingParams",
] satisfies readonly (keyof AgentHarnessStreamOptions)[];

function harnessStreamOptions(options: SimpleStreamOptions): AgentHarnessStreamOptions {
  const picked: AgentHarnessStreamOptions = {};
  for (const key of HARNESS_STREAM_OPTION_KEYS) {
    if (options[key] !== undefined) Object.assign(picked, { [key]: options[key] });
  }
  return picked;
}

function withHarnessStreamOptions(
  options: SimpleStreamOptions,
  patched: AgentHarnessStreamOptions,
): SimpleStreamOptions {
  const next: SimpleStreamOptions = { ...options };
  for (const key of HARNESS_STREAM_OPTION_KEYS) {
    if (patched[key] === undefined) delete next[key];
    else Object.assign(next, { [key]: patched[key] });
  }
  return next;
}
