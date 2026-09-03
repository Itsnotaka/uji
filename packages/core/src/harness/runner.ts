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
import { abortableSleep, isRetryableAssistantError, retryDelayMs } from "@uji-ai/ai/utils/retry";
import type { RetryCallbacks, RetryPolicy } from "@uji-ai/ai/utils/retry";
import type { Api, AssistantMessage, Message, Model, Usage } from "@uji-ai/schema";
import {
  type AgentEventSink,
  executeToolCalls,
  runAgentTurn,
  toolResultMessage,
} from "../agent-loop.ts";
import { isToolWait } from "../types.ts";
import type {
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  QueueMode,
  StreamFn,
  ThinkingLevel,
  ToolWakeOutcome,
} from "../types.ts";
import type { EphemeralEvent, ToolProgress } from "../sdk/types.ts";
import { toolErrorResult, toolResultContent } from "../utils/tool-result.ts";
import type { HarnessTool } from "./agent-harness.ts";
import { generateBranchSummary, prepareBranchSummary } from "./compaction/branch-summary.ts";
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
import { applyStreamOptionsPatch, type HookModelRef, HookRegistry } from "./hooks.ts";
import {
  buildSessionContext,
  buildSessionModelContext,
  type SessionModelContext,
} from "./session/context.ts";
import type { RunClaim, RunWriter } from "./session/store.ts";
import { newId, SessionError, toJsonValue, type JsonValue } from "./session/types.ts";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CompactionIntent,
  Entry,
  NavigationIntent,
  OperationStartedRecord,
  PendingRunWrite,
  ProvisionedEntry,
  RetryScheduledRecord,
  RunIntent,
  RunState,
  SessionStorage,
  ToolWaitingRecord,
} from "./session/types.ts";
import type { AgentHarnessStreamOptions } from "./types.ts";
import { collectAbandonedEntries } from "../views/tree.ts";

const HEAD = "main";

export type CompactionReason = "manual" | "threshold" | "overflow";

type OperationErrorCode =
  | "claim_lost"
  | "compaction"
  | "harness"
  | "navigation"
  | "policy"
  | "refused"
  | "steps"
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

export type NavigationOutcome =
  | { kind: "completed"; leafId: string | null; summaryEntry?: BranchSummaryEntry }
  | { kind: "aborted"; leafId: string | null }
  | { kind: "failed"; leafId: string | null; error: OperationError };

export type RunnerFinished =
  | { kind: "finished"; operation: "run"; runId: string; outcome: RunOutcome }
  | {
      kind: "finished";
      operation: "compaction";
      runId: string;
      outcome: CompactionOutcome;
    }
  | {
      kind: "finished";
      operation: "navigation";
      runId: string;
      outcome: NavigationOutcome;
    };

export type StepResult =
  | { kind: "continue" }
  | {
      kind: "claimed_elsewhere";
      head: string;
      holder: { runId: string; ownerId: string; expiresAtMs: number };
    }
  /**
   * The run committed its waits and released its claim: it waits for input
   * that arrives by admission and consumes no process anywhere (invariant 13).
   */
  | { kind: "waiting"; runId: string }
  | RunnerFinished;

export interface RunnerOptions {
  session: SessionStorage;
  runId: string;
  hooks: HookRegistry;
  streamFn: StreamFn;
  tools: readonly HarnessTool[];
  model: Model<Api>;
  systemPrompt: string;
  emit(event: EphemeralEvent): Promise<void>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
  /** The driving agent's turn ceiling: the run fails with code "steps" once reached. */
  steps?: number;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  streamOptions?: AgentHarnessStreamOptions;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
}

/**
 * Claim and commit one provider turn plus its complete tool batch, releasing
 * the claim before returning: the step-at-a-time placement, where the claim
 * TTL covers the gap between invocations. A hot loop uses `drive`, which
 * holds one claim across steps instead.
 */
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
      const result = await executeClaimedStep(options, current, claimed.writer);
      if (result.kind === "continue" || result.kind === "waiting") {
        await claimed.writer.release();
      }
      return result;
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export interface DriveHandoff {
  /**
   * A claim the caller already holds for this run (admission just recorded
   * `operation_started` under it). The drive owns it from here: handing it
   * over instead of releasing and re-claiming means no window in which
   * another attached host reads the brand-new run as an orphan.
   */
  writer?: RunWriter;
}

/**
 * Hot placement: claim once, execute steps in-process until one commits a
 * terminal outcome, renewing as it goes (design record, "Two runner shapes").
 * The claim is held across step boundaries; a released claim on an unfinished
 * run reads as an orphan to every other attached host, so a hot loop that
 * released between steps would invite takeover of a live run.
 */
export async function drive(
  options: RunnerOptions,
  handoff: DriveHandoff = {},
): Promise<Exclude<StepResult, { kind: "continue" }>> {
  return driveClaimed(options, { recover: false, ...handoff });
}

/**
 * Hot resume: claim an orphan once, repair its effect sandwich, then drive it
 * to a terminal outcome under that same claim.
 */
export async function resumeDrive(
  options: RunnerOptions,
): Promise<Exclude<StepResult, { kind: "continue" }>> {
  return driveClaimed(options, { recover: true });
}

async function driveClaimed(
  options: RunnerOptions,
  mode: { recover: boolean; writer?: RunWriter },
): Promise<Exclude<StepResult, { kind: "continue" }>> {
  let writer = mode.writer;
  let recover = mode.recover;
  try {
    while (true) {
      const state = await options.session.runState(options.runId);
      if (state.kind === "missing") throw new Error(`Run ${options.runId} does not exist`);
      if (state.kind === "finished") {
        return finishedFromRecord(state, await options.session.getLeafId(state.operation.head));
      }
      if (writer === undefined) {
        const claimed = await options.session.claimRun(state.operation.head, options.runId);
        if (!claimed.ok) {
          return claimedElsewhere({ head: state.operation.head, holder: claimed.holder });
        }
        writer = claimed.writer;
        continue; // re-read the state this claim now guards
      }
      if (recover) {
        recover = false;
        if (state.operation.intent.kind === "run") {
          let policyFailure: string | undefined;
          try {
            policyFailure = await recoverRunOperation(
              options,
              state,
              state.operation,
              state.operation.intent,
              writer,
            );
          } catch (error) {
            if (isClaimLost(error)) {
              const lost = await claimedElsewhereAfterFence({ options, state, writer });
              writer = undefined;
              return lost;
            }
            const outcome: RunOutcome = {
              kind: "failed",
              leafId: await options.session.getLeafId(state.operation.head),
              error: {
                code: "harness",
                message: error instanceof Error ? error.message : String(error),
              },
            };
            await finishOperation(options, writer, outcome);
            writer = undefined;
            return { kind: "finished", operation: "run", runId: state.operation.id, outcome };
          }
          if (policyFailure !== undefined) {
            const failed = await failRun(options, writer, state.operation.head, {
              code: "policy",
              message: policyFailure,
            });
            writer = undefined;
            return failed;
          }
          continue; // recovery may have settled entries the next step reads
        }
      }
      const result = await executeClaimedStep(options, state, writer);
      if (result.kind === "continue") continue;
      if (result.kind === "waiting") {
        // The wait records are durable; releasing ends this process's
        // involvement, and the released-claim event is the wake watermark.
        await writer.release();
        writer = undefined;
        return result;
      }
      // A finished step released through `finish`; a lost claim has a successor.
      writer = undefined;
      return result;
    }
  } finally {
    if (writer !== undefined) await writer.release().catch(() => undefined);
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

/** Read a finished operation off its record; `leafId` fills in when the record names none. */
export function finishedFromRecord(
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
  if (state.operation.intent.kind === "navigation") {
    return navigationFinished(state, outcome);
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

/** A finished navigation reads its summary, if any, back off the log. */
export function navigationFinished(
  state: Pick<Extract<RunState, { kind: "finished" }>, "operation" | "navigation">,
  outcome: RunOutcome,
): Extract<RunnerFinished, { operation: "navigation" }> {
  const summaryEntry = state.navigation.kind === "summarized" ? state.navigation.entry : undefined;
  return {
    kind: "finished",
    operation: "navigation",
    runId: state.operation.id,
    outcome:
      outcome.kind === "completed"
        ? {
            kind: "completed",
            leafId: outcome.leafId,
            ...(summaryEntry === undefined ? {} : { summaryEntry }),
          }
        : outcome,
  };
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
        if (state.waitingCalls.length > 0) {
          return await wakeWaitingRun(options, state, writer, controller);
        }
        return await executeRunStep(options, state, writer, controller);
      case "compaction":
        return await executeCompactionStep(
          options,
          state.operation,
          state.operation.intent,
          writer,
          controller,
        );
      case "navigation":
        return await executeNavigationStep(
          options,
          state,
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
    switch (state.operation.intent.kind) {
      case "run":
        return { kind: "finished", operation: "run", runId: options.runId, outcome };
      case "compaction":
        return { kind: "finished", operation: "compaction", runId: options.runId, outcome };
      case "navigation":
        return { kind: "finished", operation: "navigation", runId: options.runId, outcome };
      default: {
        const _exhaustive: never = state.operation.intent;
        return _exhaustive;
      }
    }
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
        kind: "diagnostic",
        level: "error",
        owner: "abort-watch",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  return () => stop.abort();
}

/**
 * Repair an orphaned run's effect sandwich. Returns the first policy-system
 * failure met while settling unstarted tool calls, if any; every call still
 * settles so the tree stays coherent, and the caller fails the run.
 */
async function recoverRunOperation(
  options: RunnerOptions,
  state: Extract<RunState, { kind: "running" }>,
  operation: OperationStartedRecord,
  intent: RunIntent,
  writer: RunWriter,
): Promise<string | undefined> {
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
      }
    }

    // Effect sandwich settlement: tool intents without their settlement entry.
    // Re-read the park records at settle time: the state snapshot can predate
    // a park committed just before this claim, and settling a parked call
    // burns its reserved entry (the second-claimant incident, seq 2985).
    const parked = new Set(
      (await options.session.findRecords({ type: "tool_waiting", runId: operation.id })).map(
        (record) => record.toolCallId,
      ),
    );
    for (const toolIntent of state.unsettledToolIntents) {
      if (parked.has(toolIntent.toolCallId)) continue;
      const tool = options.tools.find((candidate) => candidate.name === toolIntent.toolName);
      let settlement: ToolSettlement;
      if (toolIntent.replay === "safe" && tool !== undefined) {
        try {
          settlement = {
            result: await tool.execute(
              toolIntent.toolCallId,
              toolIntent.effectiveArgs,
              controller.signal,
            ),
            isError: false,
          };
        } catch (error) {
          settlement = { result: toolErrorResult(error), isError: true };
        }
      } else {
        settlement = {
          result: {
            content: toolResultContent(
              `Error: tool call "${toolIntent.toolName}" was interrupted before completing and was not ` +
                "replayed. Re-issue it if the work is still needed.",
            ),
            details: {},
          },
          isError: true,
        };
      }
      await settleReservedResult(options, writer, toolIntent, settlement);
    }

    // Calls whose assistant entry committed before their effect intent did run
    // through the same per-call sandwich a live turn uses. Only entries this
    // run appended count: an older dangling call is history, and settling it
    // here would land its result far from its assistant message.
    const recoveryBranch = await options.session.getBranch(operation.head);
    const settledToolCalls = new Set(state.toolIntents.map((toolIntent) => toolIntent.toolCallId));
    for (const entry of recoveryBranch) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        settledToolCalls.add(entry.message.toolCallId);
      }
    }
    const turn = bindTurn(options, writer, controller, state.turnAttempts);
    for (const entry of recoveryBranch) {
      if (entry.seq <= operation.seq) continue;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const unstarted = entry.message.content.filter(
        (content) => content.type === "toolCall" && !settledToolCalls.has(content.id),
      );
      if (unstarted.length === 0) continue;
      await executeToolCalls(
        { systemPrompt: options.systemPrompt, messages: [], tools: turn.tools },
        { ...entry.message, content: unstarted },
        turn.config,
        controller.signal,
        turn.emit,
      );
    }
    if (turn.waiting.size > 0) {
      await commitWaits(options, writer, await runningState(options), turn.waiting, false);
    }
    return turn.policyFailure;
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller);
    writer.claimLost.removeEventListener("abort", abortFromClaim);
  }
}

/**
 * Wake a waiting run: offer pending input to each waiting call's `wake`
 * handler and settle the reserved result entries exactly once. Any settlement
 * (including abort settlements) reports `continue`, so the caller re-reads
 * state and steps; settling nothing re-waits.
 */
async function wakeWaitingRun(
  options: RunnerOptions,
  state: Extract<RunState, { kind: "running" }>,
  writer: RunWriter,
  controller: AbortController,
): Promise<StepResult> {
  const aborted = state.abortRequested !== undefined || controller.signal.aborted;
  let progress = false;
  for (const wait of state.waitingCalls) {
    const settleAborted = async (): Promise<void> => {
      await settleReservedResult(options, writer, wait, {
        result: {
          content: toolResultContent(
            `Error: tool call "${wait.toolName}" was aborted while waiting.`,
          ),
          details: {},
        },
        isError: true,
      });
      progress = true;
    };
    const tool = options.tools.find((candidate) => candidate.name === wait.toolName);
    const intent = state.toolIntents.find((candidate) => candidate.toolCallId === wait.toolCallId);
    if (tool?.wake === undefined || intent === undefined) {
      // Invariant 21: a host without the owning plugin leaves the wait
      // alone; another host may hold the handler. Abort is the exit that
      // works everywhere, so it settles generically here.
      if (aborted) {
        await settleAborted();
        continue;
      }
      await options.emit({
        kind: "diagnostic",
        level: "warn",
        owner: "runner",
        message:
          intent === undefined
            ? `waiting call ${wait.toolCallId} has no tool_started intent`
            : `no wake handler for waiting tool "${wait.toolName}"`,
      });
      continue;
    }
    const reply = state.toolReplies.get(wait.toolCallId);
    let outcome: ToolWakeOutcome;
    try {
      outcome = await tool.wake(
        {
          runId: wait.runId,
          toolCallId: wait.toolCallId,
          resultEntryId: wait.resultEntryId,
          args: intent.effectiveArgs,
        },
        {
          signal: controller.signal,
          aborted,
          ...(reply === undefined ? {} : { reply: reply.reply }),
        },
      );
    } catch (error) {
      // Contained (invariant 21): a broken wake handler keeps the run parked
      // rather than failing it; abort remains the exit.
      await options.emit({
        kind: "diagnostic",
        level: "error",
        owner: wait.toolName,
        message: error instanceof Error ? error.message : String(error),
      });
      if (aborted) await settleAborted();
      continue;
    }
    if (outcome.kind === "settle") {
      await settleReservedResult(options, writer, wait, {
        result: outcome.result,
        isError: outcome.isError === true,
      });
      progress = true;
    } else if (aborted) {
      // A wait must not outlive an abort: the run has to reach its terminal record.
      await settleAborted();
    }
  }
  if (progress) return { kind: "continue" };
  // Mark what this pass saw; only newer input wakes the run again.
  const seen = Math.max(
    state.lastWakeObservedSeq ?? -1,
    ...state.pendingWrites.map((pending) => pending.record.seq),
    ...[...state.toolReplies.values()].map((record) => record.seq),
  );
  if (seen > (state.lastWakeObservedSeq ?? -1)) {
    await writer.appendRecord({
      type: "tool_wake_observed",
      id: newId("r"),
      head: HEAD,
      runId: options.runId,
      throughSeq: seen,
    });
  }
  return { kind: "waiting", runId: options.runId };
}

/**
 * Commit the batch's waits, or settle them as errors when the run is
 * already ending: a run never finishes with an intent that is neither settled
 * nor waiting. Returns whether the run is now waiting.
 */
async function commitWaits(
  options: RunnerOptions,
  writer: RunWriter,
  state: Extract<RunState, { kind: "running" }>,
  waiting: ReadonlySet<string>,
  ending: boolean,
): Promise<boolean> {
  for (const intent of state.toolIntents) {
    if (!waiting.has(intent.toolCallId)) continue;
    if (ending) {
      await settleReservedResult(options, writer, intent, {
        result: {
          content: toolResultContent(
            `Error: tool call "${intent.toolName}" was cancelled before its wait began.`,
          ),
          details: {},
        },
        isError: true,
      });
      continue;
    }
    await writer.appendRecord({
      type: "tool_waiting",
      id: newId("r"),
      head: HEAD,
      runId: options.runId,
      toolCallId: intent.toolCallId,
      toolName: intent.toolName,
      effectiveArgs: intent.effectiveArgs,
      resultEntryId: intent.resultEntryId,
    });
  }
  return !ending;
}

type ToolSettlement = { result: AgentToolResult<unknown>; isError: boolean };

/** Write a call's settlement at its reserved entry, exactly once. */
async function settleReservedResult(
  options: RunnerOptions,
  writer: RunWriter,
  call: Pick<ToolWaitingRecord, "toolCallId" | "toolName" | "resultEntryId">,
  settlement: ToolSettlement,
): Promise<void> {
  const { result, isError } = settlement;
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
  await writer.appendEntry({
    type: "message",
    id: call.resultEntryId,
    message: toolResultMessage(call, result, isError),
  });
}

/** Commit a failed outcome for the run and report it as this step's terminal result. */
async function failRun(
  options: RunnerOptions,
  writer: RunWriter,
  head: string,
  error: OperationError,
): Promise<Extract<RunnerFinished, { operation: "run" }>> {
  const outcome: RunOutcome = {
    kind: "failed",
    leafId: await options.session.getLeafId(head),
    error,
  };
  await finishOperation(options, writer, outcome);
  return { kind: "finished", operation: "run", runId: options.runId, outcome };
}

async function executeRunStep(
  options: RunnerOptions,
  initialState: Extract<RunState, { kind: "running" }>,
  writer: RunWriter,
  controller: AbortController,
): Promise<StepResult> {
  if (initialState.abortRequested !== undefined || controller.signal.aborted) {
    const outcome: RunOutcome = {
      kind: "aborted",
      leafId: await options.session.getLeafId(initialState.operation.head),
    };
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "run", runId: options.runId, outcome };
  }

  if (options.steps !== undefined && initialState.turnAttempts >= options.steps) {
    return failRun(options, writer, initialState.operation.head, {
      code: "steps",
      message: `Run stopped at its ${options.steps}-turn ceiling`,
    });
  }

  // An owed backoff from a previous step, including one this process never saw scheduled.
  if (initialState.retry.kind === "waiting") {
    const waited = await awaitRetryWindow(options, initialState.retry.record, controller.signal);
    if (!waited) {
      const outcome: RunOutcome = {
        kind: "aborted",
        leafId: await options.session.getLeafId(initialState.operation.head),
      };
      await finishOperation(options, writer, outcome);
      return { kind: "finished", operation: "run", runId: options.runId, outcome };
    }
  }

  const project = async (): Promise<SessionModelContext> =>
    buildSessionModelContext(await options.session.getBranch(initialState.operation.head), {
      provider: options.model.provider,
      api: options.model.api,
      model: options.model.id,
    });

  await drainWrites(options, writer, initialState.turnAttempts === 0 ? "checkpoint" : "deferred");
  let projection = await project();
  let { messages } = projection;
  const initialTail = messages.at(-1);
  if (initialTail?.role !== "user" && initialTail?.role !== "toolResult") {
    await drainWrites(options, writer, "checkpoint");
    projection = await project();
    messages = projection.messages;
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
      projection = await project();
      messages = projection.messages;
    }
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

  const turn = bindTurn(options, writer, controller, initialState.turnAttempts);
  await runAgentTurn(
    { systemPrompt: options.systemPrompt, ...projection, tools: turn.tools },
    turn.config,
    turn.emit,
    controller.signal,
    turn.streamFn,
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
  if (turn.waiting.size > 0) {
    const state = await runningState(options);
    // A run that is already ending (abort, policy failure) must not park
    // open: its waits settle as errors instead, so no intent is left
    // neither settled nor waiting when the terminal record lands.
    const ending =
      turn.policyFailure !== undefined ||
      controller.signal.aborted ||
      state.abortRequested !== undefined;
    const committed = await commitWaits(options, writer, state, turn.waiting, ending);
    if (committed) return { kind: "waiting", runId: options.runId };
  }
  // A policy that could not decide is a harness-side failure, not a model
  // mistake: the batch has settled every call, so the tree is coherent, and
  // the run stops here rather than driving the model past a broken gate.
  if (turn.policyFailure !== undefined) {
    return failRun(options, writer, initialState.operation.head, {
      code: "policy",
      message: turn.policyFailure,
    });
  }

  if (turn.lastTurn.stopReason !== "aborted") {
    const overflow = isOverflowOrRecoverableLength(options, turn.lastTurn);
    if (overflow) {
      const willRetry = turn.lastTurn.stopReason !== "stop";
      const compacted = initialState.compaction.overflowRecovered
        ? undefined
        : await runAutomaticCompaction(options, writer, "overflow", controller.signal);
      if (willRetry && compacted?.kind === "completed" && !controller.signal.aborted) {
        return { kind: "continue" };
      }
    } else {
      await compactForThreshold(options, writer, turn.lastTurn, controller.signal);
    }
  }

  // Checked after overflow, so an oversized request compacts rather than retrying unchanged
  // (pi harness.md 3.7). The failed turn stays in the tree as durable history; context
  // projection already drops errored assistant messages, so it cannot poison the next attempt.
  if (
    turn.lastTurn.stopReason === "error" &&
    !controller.signal.aborted &&
    (await scheduleAssistantRetry(options, writer, initialState, turn.lastTurn))
  ) {
    return { kind: "continue" };
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
  const branch = buildSessionContext(await options.session.getBranch(HEAD));
  const afterCheckpoint = await runningState(options);
  const tail = branch.at(-1);
  const hasContinuableTail = tail?.role === "user" || tail?.role === "toolResult";
  const toolCalls = turn.lastTurn.content.filter((content) => content.type === "toolCall");
  const toolBatchContinues = toolCalls.length > 0;
  if (toolBatchContinues || hasContinuableTail || hasPendingSteer(afterCheckpoint)) {
    return { kind: "continue" };
  }

  const followUps =
    initialState.operation.intent.kind === "run" &&
    initialState.operation.intent.promotionScope === "steer"
      ? 0
      : await drainWrites(options, writer, "followUp");
  if (followUps > 0) {
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
    if (pending.kind !== "deferred") {
      await writer.appendRecord({
        type: "queue_consumed",
        id: newId("r"),
        head: HEAD,
        runId: options.runId,
        entryId: entry.id,
      });
    }
  }
  return selected.length;
}

/**
 * One turn's binding of the loop to the log: the callbacks that write the
 * effect sandwich (`tool_started`, usage, result entries) and the event sink
 * that stamps entry ids. A live turn runs the whole loop over it; recovery
 * runs only the tool batch, so both settle calls through the same code.
 */
interface BoundTurn {
  readonly config: AgentLoopConfig;
  readonly emit: AgentEventSink;
  readonly streamFn: StreamFn;
  readonly tools: HarnessTool[];
  /** Calls that parked waiting, by tool call id. */
  readonly waiting: ReadonlySet<string>;
  /** The assistant message the turn ended with, once it has. */
  lastTurn: AssistantMessage | undefined;
  /** The first `error` decision a `before_tool` policy returned in this batch. */
  policyFailure: string | undefined;
}

function bindTurn(
  options: RunnerOptions,
  writer: RunWriter,
  controller: AbortController,
  previousAttempt: number,
): BoundTurn {
  const toolResultIds = new Map<string, string>();
  let assistantEntryId: string | undefined;
  const clearedArgs = new Map<string, Record<string, JsonValue>>();
  const waiting = new Set<string>();
  const { signal } = controller;
  let currentSystemPrompt = options.systemPrompt;
  let attempt = previousAttempt;
  const baseStream = hookedStream(options, "assistant", () => attempt, signal);

  const toolResultEntryId = (toolCallId: string): string => {
    const existing = toolResultIds.get(toolCallId);
    if (existing !== undefined) return existing;
    const provisioned = newId("e");
    toolResultIds.set(toolCallId, provisioned);
    return provisioned;
  };
  const recordUsage = async (cause: "assistant" | "tool", usage: Usage): Promise<void> => {
    await writer.appendRecord({
      type: "usage",
      id: newId("r"),
      head: HEAD,
      runId: options.runId,
      cause,
      usage,
    });
  };

  const turn: BoundTurn = {
    tools: bindTools(options.tools, clearedArgs, waiting),
    waiting,
    lastTurn: undefined,
    policyFailure: undefined,
    streamFn: (model, llmContext, streamOptions) =>
      baseStream(model, { ...llmContext, systemPrompt: currentSystemPrompt }, streamOptions),
    // The loop's events settle into the log and stream out as overlays that
    // name the entry they settle into; the durable event is the entry itself.
    emit: async (event) => {
      switch (event.type) {
        case "turn_start":
          attempt += 1;
          await writer.appendRecord({
            type: "step_attempt",
            id: newId("r"),
            head: HEAD,
            runId: options.runId,
            step: "assistant",
            attempt,
          });
          return;
        case "turn_end":
          if (event.message.role !== "assistant") {
            throw new Error("turn_end must carry an assistant message");
          }
          turn.lastTurn = event.message;
          await recordUsage("assistant", event.message.usage);
          return;
        case "message_start":
          if (event.message.role === "assistant") assistantEntryId = newId("e");
          return;
        case "message_update": {
          assistantEntryId ??= newId("e");
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            await options.emit({
              kind: "text_delta",
              entryId: assistantEntryId,
              contentIndex: update.contentIndex,
              delta: update.delta,
            });
          } else if (update.type === "thinking_delta") {
            await options.emit({
              kind: "reasoning_delta",
              entryId: assistantEntryId,
              contentIndex: update.contentIndex,
              delta: update.delta,
            });
          }
          return;
        }
        case "message_end": {
          // A parked call has no settlement: its reserved entry stays open
          // for the wake, and clients learn from the durable record instead.
          if (event.message.role === "toolResult" && waiting.has(event.message.toolCallId)) return;
          const id =
            (event.message.role === "assistant"
              ? assistantEntryId
              : event.message.role === "toolResult"
                ? toolResultEntryId(event.message.toolCallId)
                : undefined) ?? newId("e");
          await writer.appendEntry({ type: "message", id, message: event.message });
          if (event.message.role === "assistant") assistantEntryId = undefined;
          return;
        }
        case "tool_execution_start":
          return;
        case "tool_execution_update":
          await options.emit({
            kind: "tool_progress",
            entryId: toolResultEntryId(event.toolCallId),
            callId: event.toolCallId,
            progress: toolProgress(event.partialResult),
          });
          return;
        case "tool_execution_end":
          if (event.result.usage !== undefined && !waiting.has(event.toolCallId)) {
            await recordUsage("tool", event.result.usage);
          }
          return;
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    },
    config: {
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
          signal,
        );
        if (result?.systemPrompt !== undefined) currentSystemPrompt = result.systemPrompt;
        return result?.messages ?? candidateMessages;
      },
      convertToLlm: (candidateMessages) =>
        candidateMessages.filter((message): message is Message => isProviderMessage(message)),
      reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
      beforeToolCall: async ({ toolCall, args }) => {
        // The loop admits calls one at a time, so once a policy has failed no
        // later call in the batch starts an effect; calls already admitted
        // keep their effect sandwich and settle normally.
        if (turn.policyFailure !== undefined) return { block: true, reason: turn.policyFailure };
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
            signal,
          );
          switch (decision.action) {
            case "continue":
              break;
            case "modify":
              effectiveArgs = decision.args;
              clearedArgs.set(toolCall.id, effectiveArgs);
              break;
            case "reject":
              return { block: true, reason: decision.message };
            case "error":
              turn.policyFailure ??= decision.message;
              return { block: true, reason: decision.message };
            default: {
              const _exhaustive: never = decision;
              return _exhaustive;
            }
          }
        }
        await writer.appendRecord({
          type: "tool_started",
          id: newId("r"),
          head: HEAD,
          runId: options.runId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          effectiveArgs,
          resultEntryId: toolResultEntryId(toolCall.id),
          replay: tool?.replay ?? "never",
        });
        return undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        // A parked call has no result; it settles on wake, not here.
        if (waiting.has(toolCall.id)) return undefined;
        // `after_tool` sees what the effect received: a policy's modification
        // where there was one, the validated proposal otherwise.
        const effectiveArgs = clearedArgs.get(toolCall.id) ?? toolArguments(toolCall.name, args);
        clearedArgs.delete(toolCall.id);
        if (!options.hooks.has("after_tool")) return undefined;
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
          signal,
        );
        if (patch === undefined) return undefined;
        return {
          ...(patch.content === undefined ? {} : { content: patch.content }),
          ...(patch.details === undefined ? {} : { details: patch.details }),
          ...(patch.isError === undefined ? {} : { isError: patch.isError }),
          ...(patch.usage === undefined ? {} : { usage: patch.usage }),
        };
      },
    },
  };
  return turn;
}

function bindTools(
  source: readonly HarnessTool[],
  clearedArgs: ReadonlyMap<string, unknown>,
  waitingCallIds: Set<string>,
): HarnessTool[] {
  return source.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      try {
        return await tool.execute(
          toolCallId,
          clearedArgs.get(toolCallId) ?? params,
          signal,
          onUpdate,
        );
      } catch (error) {
        if (isToolWait(error)) {
          // The marker never settles: its events are suppressed and a
          // tool_waiting record commits instead.
          waitingCallIds.add(toolCallId);
          return { content: toolResultContent("Waiting for input."), details: {} };
        }
        throw error;
      }
    },
  }));
}

function hookedStream(
  runner: RunnerOptions,
  stepKind: "assistant" | "compaction" | "branch_summary",
  attempt: () => number,
  signal: AbortSignal,
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
          signal,
        );
        if (result?.streamOptions !== undefined) {
          const patched = applyStreamOptionsPatch(
            harnessStreamOptions(streamOptions),
            result.streamOptions,
          );
          streamOptions = withHarnessStreamOptions(streamOptions, patched);
        }
      }
      const inner = await runner.streamFn(model, llmContext, streamOptions);
      for await (const event of inner) out.push(event);
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

/**
 * A tool's partial result is author-shaped and typed `any` upstream, so it is
 * narrowed here like any boundary value: text parts flatten, images become
 * placeholders, anything else contributes nothing.
 */
export function toolProgress(partialResult: unknown): ToolProgress {
  if (typeof partialResult !== "object" || partialResult === null) return { text: "" };
  const content = "content" in partialResult ? partialResult.content : undefined;
  const title = "title" in partialResult ? partialResult.title : undefined;
  const details = "details" in partialResult ? jsonDetails(partialResult.details) : undefined;
  const text = Array.isArray(content)
    ? content
        .map(partText)
        .filter((part) => part !== "")
        .join("\n")
    : "";
  return {
    text,
    ...(typeof title === "string" ? { title } : {}),
    ...(details === undefined ? {} : { details }),
  };
}

/** A partial that does not round-trip through JSON drops rather than throws (invariant 31). */
function jsonDetails(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return toJsonValue(value);
  } catch {
    return undefined;
  }
}

function partText(part: unknown): string {
  if (typeof part !== "object" || part === null || !("type" in part)) return "";
  if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
  if (part.type === "image" && "mimeType" in part && typeof part.mimeType === "string") {
    return `[image ${part.mimeType}]`;
  }
  return "";
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
  await options.emit({ kind: "compacting", runId: options.runId, reason });
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
    const branch = await options.session.getBranch(HEAD);
    const modelContext = buildSessionModelContext(branch, {
      provider: options.model.provider,
      api: options.model.api,
      model: options.model.id,
    });
    const hookResult = options.hooks.has("before_compaction")
      ? await options.hooks.run(
          "before_compaction",
          {
            head: HEAD,
            runId: options.runId,
            model: { provider: options.model.provider, modelId: options.model.id },
            context: {
              systemPrompt: options.systemPrompt,
              ...modelContext,
              tools: [...options.tools],
            },
            reason,
            ...(customInstructions === undefined ? {} : { customInstructions }),
            tokensBefore: preparation.tokensBefore,
          },
          signal,
        )
      : undefined;

    const compacted = await compactSession(
      preparation,
      hookedStream(options, "compaction", () => 1, signal),
      options.model,
      customInstructions,
      options.thinkingLevel,
      retryPolicy(options),
      retryCallbacks(options),
      signal,
    );
    const leafId = (): Promise<string | null> => options.session.getLeafId(HEAD);
    if (!compacted.ok) {
      if (compacted.error.code === "aborted") return { kind: "aborted", leafId: await leafId() };
      return {
        kind: "failed",
        leafId: await leafId(),
        error: { code: compacted.error.code, message: compacted.error.message },
      };
    }
    const value = {
      ...compacted.value,
      ...(hookResult === undefined ? {} : { material: hookResult.material }),
    };
    if (signal.aborted) return { kind: "aborted", leafId: await leafId() };

    const saved = await writer.appendEntry({
      type: "compaction",
      id: newId("e"),
      summary: value.summary,
      retainedTail: value.retainedTail,
      tokensBefore: value.tokensBefore,
      ...(value.material === undefined ? {} : { material: value.material }),
      ...(value.details === undefined ? {} : { details: toJsonValue(value.details) }),
      ...(value.usage === undefined ? {} : { usage: value.usage }),
      fromHook: hookResult !== undefined,
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
    return { kind: "completed", leafId: saved.id, entry: saved };
  } catch (cause) {
    if (isClaimLost(cause)) throw cause;
    return {
      kind: "failed",
      leafId: await options.session.getLeafId(HEAD),
      error: {
        code: "compaction",
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

/**
 * A structural run. Nothing is written until the summary, if any, exists in
 * memory: an abort or a failure before then leaves the session exactly as it
 * was. Then, in order: re-point the head, append the summary under its
 * provisioned id, settle. Each write is idempotent under resume: a summary
 * already on the log means the crash landed after the append, and a head
 * move repeats harmlessly.
 */
async function executeNavigationStep(
  options: RunnerOptions,
  state: Extract<RunState, { kind: "running" }>,
  intent: NavigationIntent,
  writer: RunWriter,
  controller: AbortController,
): Promise<RunnerFinished> {
  const { operation } = state;
  const head = operation.head;
  const finish = async (outcome: NavigationOutcome): Promise<RunnerFinished> => {
    await finishOperation(options, writer, outcome);
    return { kind: "finished", operation: "navigation", runId: options.runId, outcome };
  };
  const unchanged = async (): Promise<string | null> => options.session.getLeafId(head);

  const settled = state.navigation.kind === "summarized" ? state.navigation : undefined;
  if (settled !== undefined) {
    if ((await options.session.getLeafId(head)) !== settled.entry.id) {
      await writer.moveHead(settled.entry.id);
    }
    if (!settled.usageRecorded) {
      await recordBranchSummaryUsage(options, writer, settled.entry);
    }
    return finish({ kind: "completed", leafId: settled.entry.id, summaryEntry: settled.entry });
  }

  if (intent.targetId !== null && (await options.session.getEntry(intent.targetId)) === undefined) {
    return finish({
      kind: "failed",
      leafId: await unchanged(),
      error: { code: "navigation", message: `Entry not found: ${intent.targetId}` },
    });
  }

  let summary: ProvisionedEntry<BranchSummaryEntry> | undefined;
  if (intent.summary !== undefined && operation.sourceLeafId !== null) {
    const generated = await summarizeAbandonedBranch(
      options,
      writer,
      state,
      intent,
      intent.summary,
      operation.sourceLeafId,
      controller.signal,
    );
    if (generated.kind === "aborted") return finish({ kind: "aborted", leafId: await unchanged() });
    if (generated.kind === "failed") {
      return finish({ kind: "failed", leafId: await unchanged(), error: generated.error });
    }
    summary = generated.entry;
  }
  if (controller.signal.aborted) return finish({ kind: "aborted", leafId: await unchanged() });

  await writer.moveHead(intent.targetId);
  if (summary === undefined) return finish({ kind: "completed", leafId: intent.targetId });
  const saved = await writer.appendEntry(summary);
  if (saved.type !== "branch_summary") {
    throw new Error(`Expected a branch_summary entry, received ${saved.type}`);
  }
  await recordBranchSummaryUsage(options, writer, saved);
  return finish({ kind: "completed", leafId: saved.id, summaryEntry: saved });
}

async function recordBranchSummaryUsage(
  options: RunnerOptions,
  writer: RunWriter,
  entry: BranchSummaryEntry,
): Promise<void> {
  if (entry.usage === undefined) return;
  await writer.appendRecord({
    type: "usage",
    id: newId("r"),
    head: HEAD,
    runId: options.runId,
    cause: "branch_summary",
    usage: entry.usage,
  });
}

type BranchSummaryStep =
  | { kind: "summary"; entry: ProvisionedEntry<BranchSummaryEntry> | undefined }
  | { kind: "aborted" }
  | { kind: "failed"; error: OperationError };

/** Summarize the branch the head is leaving. Writes only its attempt record. */
async function summarizeAbandonedBranch(
  options: RunnerOptions,
  writer: RunWriter,
  state: Extract<RunState, { kind: "running" }>,
  intent: NavigationIntent,
  request: NonNullable<NavigationIntent["summary"]>,
  sourceLeafId: string,
  signal: AbortSignal,
): Promise<BranchSummaryStep> {
  const byId = new Map<string, Entry>();
  for (const entry of await options.session.findEntries()) byId.set(entry.id, entry);
  const { entries } = collectAbandonedEntries(byId, sourceLeafId, intent.selectedId);
  const settings = compactionSettings(options);
  const preparation = prepareBranchSummary(
    entries,
    Math.max(0, options.model.contextWindow - settings.reserveTokens),
  );
  if (preparation.messages.length === 0) return { kind: "summary", entry: undefined };

  const attempt = state.navigation.attempts + 1;
  await writer.appendRecord({
    type: "step_attempt",
    id: newId("r"),
    head: HEAD,
    runId: options.runId,
    step: "branch_summary",
    attempt,
  });
  const generated = await generateBranchSummary(
    preparation,
    hookedStream(options, "branch_summary", () => attempt, signal),
    options.model,
    settings.reserveTokens,
    request.customInstructions,
    options.thinkingLevel,
    retryPolicy(options),
    retryCallbacks(options),
    signal,
  );
  if (!generated.ok) {
    if (generated.error.code === "aborted") return { kind: "aborted" };
    return {
      kind: "failed",
      error: { code: generated.error.code, message: generated.error.message },
    };
  }
  return {
    kind: "summary",
    entry: {
      type: "branch_summary",
      id: request.entryId,
      fromId: sourceLeafId,
      selectedId: intent.selectedId,
      summary: generated.value.summary,
      details: toJsonValue(generated.value.details),
      usage: generated.value.usage,
    },
  };
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

  const state = await runningState(options);
  const latestCompaction =
    state.compaction.kind === "compacted" ? state.compaction.entry : undefined;
  if (latestCompaction !== undefined && assistantMessage.timestamp <= latestCompaction.timestamp) {
    return undefined;
  }

  const directContextTokens = calculateContextTokens(assistantMessage.usage);
  let contextTokens = directContextTokens;
  if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
    const messages = buildSessionContext(await options.session.getBranch(HEAD));
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
  outcome: RunOutcome | CompactionOutcome | NavigationOutcome,
): Promise<void> {
  await writer.finish({
    type: "operation_finished",
    id: newId("r"),
    head: HEAD,
    runId: options.runId,
    outcome: outcome.kind,
    leafId: outcome.leafId,
    ...(outcome.kind === "failed" ? { error: outcome.error } : {}),
  });
}

function compactionSettings(options: RunnerOptions): CompactionSettings {
  return options.compaction ?? DEFAULT_COMPACTION_SETTINGS;
}

function retryPolicy(options: RunnerOptions): RetryPolicy {
  return options.retry ?? DEFAULT_RETRY_POLICY;
}

/**
 * Commit an owed retry for the assistant turn, or decline and let the run fail.
 *
 * Unlike the compaction and branch-summary calls, which retry inside one step, this writes
 * the attempt and its wake time to the log first. A process lost during the backoff resumes
 * the wait instead of restarting the turn, and the count survives with it (pi harness.md 3.7).
 */
async function scheduleAssistantRetry(
  options: RunnerOptions,
  writer: RunWriter,
  state: Extract<RunState, { kind: "running" }>,
  message: AssistantMessage,
): Promise<boolean> {
  const policy = retryPolicy(options);
  if (!policy.enabled || state.retry.depth >= policy.maxRetries) return false;
  if (!isRetryableAssistantError(message)) return false;

  const attempt = state.retry.depth + 1;
  const notBefore = Date.now() + retryDelayMs(policy, attempt);
  const errorMessage = message.errorMessage ?? "Unknown error";
  await writer.appendRecord({
    type: "retry_scheduled",
    id: newId("r"),
    head: HEAD,
    runId: options.runId,
    attempt,
    notBefore,
    errorMessage,
  });
  await options.emit({
    kind: "retry_scheduled",
    runId: options.runId,
    attempt,
    maxAttempts: policy.maxRetries,
    at: notBefore,
    message: errorMessage,
  });
  return true;
}

/**
 * Sleep out a committed backoff. Returns false when the run was aborted while waiting.
 *
 * The claim heartbeat renews underneath this, so holding it across the wait is the same
 * as holding it across a long tool call. A host that would rather not hold a process open
 * can read `notBefore` off the run state and schedule its own wake instead.
 */
async function awaitRetryWindow(
  options: RunnerOptions,
  record: RetryScheduledRecord,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await abortableSleep(Math.max(0, record.notBefore - Date.now()), signal);
  } catch {
    return false;
  }
  if (signal.aborted) return false;
  await options.emit({ kind: "retry_started", runId: options.runId, attempt: record.attempt });
  return true;
}

/**
 * Publish the backoff of the in-memory retry loop, so a compaction that is waiting reads
 * as waiting rather than as a stall. The step's own outcome reports whether it eventually
 * succeeded, so there is nothing to publish once the wait is over.
 */
function retryCallbacks(options: RunnerOptions): RetryCallbacks {
  // The waiting attempt, carried from the scheduled callback because the AI package's
  // attempt-start callback takes no arguments.
  let waiting = 0;
  return {
    onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
      waiting = attempt;
      await options.emit({
        kind: "retry_scheduled",
        runId: options.runId,
        attempt,
        maxAttempts,
        at: Date.now() + delayMs,
        message: errorMessage,
      });
    },
    onRetryAttemptStart: async () => {
      await options.emit({ kind: "retry_started", runId: options.runId, attempt: waiting });
    },
  };
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

/** Read a durable `operation_finished` error back into the typed union; unknown codes read as `harness`. */
export function normalizeOperationError(
  error: { code: string; message: string } | undefined,
): OperationError {
  if (error === undefined) return { code: "harness", message: "run failed" };
  switch (error.code) {
    case "claim_lost":
    case "compaction":
    case "harness":
    case "navigation":
    case "policy":
    case "refused":
    case "steps":
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
