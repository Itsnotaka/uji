/** Pure runner-state projection over the durable session log. */
import type {
  AbortRequestedRecord,
  BranchSummaryEntry,
  CompactionEntry,
  LogItem,
  OperationFinishedRecord,
  OperationStartedRecord,
  PendingRunWrite,
  QueueEnqueuedRecord,
  RetryScheduledRecord,
  RunState,
  ToolReplyRecord,
  ToolStartedRecord,
  ToolWaitingRecord,
} from "./types.ts";

/**
 * Wake input a parked run has not observed: a reply for a live wait, a
 * deferred write, or a durable abort. Queued messages never wake; they are
 * input for after the settlement. Behind both the attach check and
 * `runs.wait`.
 */
export function hasWakeInput(state: RunState): boolean {
  if (state.kind !== "running") return false;
  if (state.abortRequested !== undefined) return true;
  const observed = state.lastWakeObservedSeq ?? -1;
  const waiting = new Set(state.waitingCalls.map((record) => record.toolCallId));
  for (const reply of state.toolReplies.values()) {
    if (waiting.has(reply.toolCallId) && reply.seq > observed) return true;
  }
  // Deferred writes older than the run are next-run input, not wake input.
  const floor = Math.max(observed, state.operation.seq);
  return state.pendingWrites.some(
    (pending) => pending.kind === "deferred" && pending.record.seq > floor,
  );
}

export function projectRunState(log: readonly LogItem[], runId: string): RunState {
  let operation: OperationStartedRecord | undefined;
  let finished: OperationFinishedRecord | undefined;
  let abortRequested: AbortRequestedRecord | undefined;
  let turnAttempts = 0;
  // Owed backoff, cleared once the attempt it scheduled actually starts.
  let retryWait: RetryScheduledRecord | undefined;
  // Retries since the last assistant turn that produced something. Resets on progress.
  let retryDepth = 0;
  let compactionAttempts = 0;
  let branchSummaryAttempts = 0;
  let branchSummaryUsageRecorded = false;
  const toolIntents: ToolStartedRecord[] = [];
  const waitingByCall = new Map<string, ToolWaitingRecord>();
  const toolReplies = new Map<string, ToolReplyRecord>();
  let lastWakeObservedSeq: number | null = null;
  let lastClaimExpiresAt: number | undefined;
  const entryIds = new Set<string>();
  const entries = new Map<string, Extract<LogItem, { kind: "entry" }>["entry"]>();
  const headLeaves = new Map<string, string | null>();
  const cancelledEntryIds = new Set<string>();

  for (const item of log) {
    switch (item.kind) {
      case "entry": {
        entryIds.add(item.entry.id);
        entries.set(item.entry.id, item.entry);
        // A turn that settled without a provider error is progress: the budget starts over.
        const settled = item.entry;
        if (
          settled.type === "message" &&
          settled.message.role === "assistant" &&
          settled.message.stopReason !== "error"
        ) {
          retryDepth = 0;
        }
        break;
      }
      case "record": {
        const record = item.record;
        if (record.type === "queue_cancelled") cancelledEntryIds.add(record.entryId);
        if (record.type === "operation_started" && record.id === runId) operation = record;
        if (record.type === "operation_finished" && record.runId === runId) finished = record;
        if (record.type === "step_attempt" && record.runId === runId) {
          switch (record.step) {
            case "assistant":
              turnAttempts = Math.max(turnAttempts, record.attempt);
              // The scheduled attempt has begun; nothing is owed until it fails again.
              retryWait = undefined;
              break;
            case "compaction":
              compactionAttempts = Math.max(compactionAttempts, record.attempt);
              break;
            case "branch_summary":
              branchSummaryAttempts = Math.max(branchSummaryAttempts, record.attempt);
              break;
            default: {
              const _exhaustive: never = record.step;
              void _exhaustive;
            }
          }
        }
        if (record.type === "retry_scheduled" && record.runId === runId) {
          retryWait = record;
          retryDepth += 1;
        }
        if (record.type === "tool_started" && record.runId === runId) {
          toolIntents.push(record);
        }
        if (record.type === "tool_waiting" && record.runId === runId) {
          waitingByCall.set(record.toolCallId, record);
        }
        if (record.type === "tool_reply" && !toolReplies.has(record.toolCallId)) {
          toolReplies.set(record.toolCallId, record);
        }
        if (record.type === "tool_wake_observed" && record.runId === runId) {
          lastWakeObservedSeq = Math.max(
            lastWakeObservedSeq ?? record.throughSeq,
            record.throughSeq,
          );
        }
        if (record.type === "abort_requested" && record.runId === runId) {
          abortRequested = record;
        }
        if (
          record.type === "usage" &&
          record.runId === runId &&
          record.cause === "branch_summary"
        ) {
          branchSummaryUsageRecorded = true;
        }
        break;
      }
      case "head":
        headLeaves.set(item.head, item.leafId);
        break;
      case "claim":
        if (item.event.kind !== "released" && item.event.claim.runId === runId) {
          lastClaimExpiresAt = item.event.claim.expiresAtMs;
        }
        break;
      case "fact":
      case "fact_value":
        break;
      default: {
        const _exhaustive: never = item;
        void _exhaustive;
      }
    }
  }

  if (operation === undefined) return { kind: "missing", runId };

  let summaryEntry: BranchSummaryEntry | undefined;
  if (operation.intent.kind === "navigation" && operation.intent.summary !== undefined) {
    const candidate = entries.get(operation.intent.summary.entryId);
    if (candidate?.type === "branch_summary") summaryEntry = candidate;
  }

  let latestCompaction: CompactionEntry | undefined;
  const queueRecords = new Map<string, QueueEnqueuedRecord>();
  const pendingWrites: PendingRunWrite[] = [];
  const branchEntryIds = new Set<string>();
  let branchEntryId = headLeaves.get(operation.head) ?? null;
  while (branchEntryId !== null) {
    const entry = entries.get(branchEntryId);
    if (entry === undefined) break;
    branchEntryIds.add(entry.id);
    branchEntryId = entry.parentId;
  }

  for (const item of log) {
    if (
      item.kind === "entry" &&
      branchEntryIds.has(item.entry.id) &&
      item.entry.type === "compaction"
    ) {
      latestCompaction = item.entry;
      continue;
    }
    if (item.kind !== "record" || item.record.head !== operation.head) continue;
    const record = item.record;
    if (record.type === "queue_enqueued") {
      queueRecords.set(record.target.id, record);
      continue;
    }
    if (
      record.type === "deferred_write" &&
      !entryIds.has(record.target.id) &&
      !cancelledEntryIds.has(record.target.id)
    ) {
      pendingWrites.push({ kind: "deferred", record });
    }
  }

  for (const record of queueRecords.values()) {
    if (entryIds.has(record.target.id) || cancelledEntryIds.has(record.target.id)) continue;
    pendingWrites.push({ kind: record.queue, record });
  }
  pendingWrites.sort((left, right) => left.record.seq - right.record.seq);

  const waitingCalls = [...waitingByCall.values()].filter(
    (record) => !entryIds.has(record.resultEntryId),
  );
  const waitingCallIds = new Set(waitingCalls.map((record) => record.toolCallId));
  const base = {
    operation,
    toolIntents,
    unsettledToolIntents: toolIntents.filter(
      (intent) => !entryIds.has(intent.resultEntryId) && !waitingCallIds.has(intent.toolCallId),
    ),
    waitingCalls,
    toolReplies,
    lastWakeObservedSeq,
    turnAttempts,
    retry:
      retryWait === undefined
        ? { kind: "none", depth: retryDepth }
        : { kind: "waiting", depth: retryDepth, record: retryWait },
    compaction:
      latestCompaction === undefined
        ? { kind: "none", attempts: compactionAttempts, overflowRecovered: false }
        : {
            kind: "compacted",
            attempts: compactionAttempts,
            overflowRecovered:
              latestCompaction.seq > operation.seq && latestCompaction.reason === "overflow",
            entry: latestCompaction,
          },
    navigation:
      summaryEntry === undefined
        ? { kind: "pending", attempts: branchSummaryAttempts }
        : {
            kind: "summarized",
            attempts: branchSummaryAttempts,
            entry: summaryEntry,
            usageRecorded: branchSummaryUsageRecorded,
          },
    pendingWrites,
    abortRequested,
    lastClaimExpiresAt,
  } satisfies Omit<Extract<RunState, { kind: "running" }>, "kind">;

  return finished === undefined
    ? { kind: "running", ...base }
    : { kind: "finished", ...base, finished };
}
