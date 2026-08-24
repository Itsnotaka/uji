/** Pure runner-state projection over the durable session log. */
import type {
  AbortRequestedRecord,
  CompactionEntry,
  LogItem,
  OperationFinishedRecord,
  OperationStartedRecord,
  PendingRunWrite,
  QueueEnqueuedRecord,
  RunState,
  StepAttemptRecord,
  ToolStartedRecord,
} from "./types.ts";

export function projectRunState(log: readonly LogItem[], runId: string): RunState {
  let operation: OperationStartedRecord | undefined;
  let finished: OperationFinishedRecord | undefined;
  let lastStepAttempt: StepAttemptRecord | undefined;
  let abortRequested: AbortRequestedRecord | undefined;
  let retryCount = 0;
  let compactionAttempts = 0;
  const toolIntents: ToolStartedRecord[] = [];
  const entryIds = new Set<string>();
  const entries = new Map<string, Extract<LogItem, { kind: "entry" }>["entry"]>();
  const headLeaves = new Map<string, string | null>();
  const cancelledEntryIds = new Set<string>();

  for (const item of log) {
    switch (item.kind) {
      case "entry":
        entryIds.add(item.entry.id);
        entries.set(item.entry.id, item.entry);
        break;
      case "record": {
        const record = item.record;
        if (record.type === "queue_cancelled") cancelledEntryIds.add(record.entryId);
        if (record.type === "operation_started" && record.id === runId) operation = record;
        if (record.type === "operation_finished" && record.runId === runId) finished = record;
        if (record.type === "step_attempt" && record.runId === runId) {
          lastStepAttempt = record;
          if (record.step === "assistant") retryCount = Math.max(retryCount, record.attempt);
          else compactionAttempts = Math.max(compactionAttempts, record.attempt);
        }
        if (record.type === "tool_started" && record.runId === runId) {
          toolIntents.push(record);
        }
        if (record.type === "abort_requested" && record.runId === runId) {
          abortRequested = record;
        }
        break;
      }
      case "head":
        headLeaves.set(item.head, item.leafId);
        break;
      case "claim":
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

  let latestCompaction: CompactionEntry | undefined;
  let highestConsumedQueueSeq: number | null = null;
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
      if (entryIds.has(record.target.id)) {
        highestConsumedQueueSeq = Math.max(highestConsumedQueueSeq ?? record.seq, record.seq);
      }
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

  const base = {
    operation,
    lastStepAttempt,
    toolIntents,
    unsettledToolIntents: toolIntents.filter((intent) => !entryIds.has(intent.resultEntryId)),
    highestConsumedQueueSeq,
    retryCount,
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
    pendingWrites,
    abortRequested,
  } satisfies Omit<Extract<RunState, { kind: "running" }>, "kind">;

  return finished === undefined
    ? { kind: "running", ...base }
    : { kind: "finished", ...base, finished };
}
