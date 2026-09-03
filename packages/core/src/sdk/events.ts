/**
 * The log is the event stream. This projects one `LogItem` into the durable
 * `SessionEvent` a client renders. Ephemeral overlays are built where they
 * happen: the runner stamps deltas and tool progress with the entry id they
 * settle into, and the harness and plugin host emit their own notices.
 *
 * Nothing here reads storage: a projection consumes what it was handed, so a
 * replaying watcher and a live watcher produce the same events for the same
 * item. That rule shapes the event types: an event carries exactly what its
 * log item knows. Claim state has its own `claim` events; projecting usage
 * onto a run boundary event would mean inventing values here.
 */
import type { Entry, LogItem } from "../harness/session/types.ts";
import { transcriptFromEntries } from "../views/transcript.ts";
import type { DurableEvent, RunEnd } from "./types.ts";

/**
 * A durable item becomes at most one event. Items with no client meaning
 * (step attempts, tool intents, usage records, internal facts) project to
 * `undefined` rather than to a event kind nobody renders.
 */
export function durableEvent(item: LogItem): DurableEvent | undefined {
  switch (item.kind) {
    case "entry":
      return entryEvent(item.entry, item.seq);
    case "head":
      return {
        seq: item.seq,
        kind: "head_moved",
        head: item.head,
        to: item.leafId,
        by: item.by,
      };
    case "fact":
      return { seq: item.seq, kind: "name_changed", name: item.name };
    case "claim":
      return {
        seq: item.seq,
        kind: "claim",
        head: item.event.kind === "released" ? item.event.head : item.event.claim.head,
        runId: item.event.kind === "released" ? item.event.runId : item.event.claim.runId,
        state: item.event.kind,
      };
    case "record":
      return recordEvent(item, item.seq);
    case "fact_value":
      return undefined;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function entryEvent(entry: Entry, seq: number): DurableEvent | undefined {
  if (entry.type === "compaction") {
    return { seq, kind: "compaction", entryId: entry.id, summary: entry.summary };
  }
  // One entry projects on its own so a live watcher never re-reads the branch.
  // A client that wants the assembled conversation calls `messages.list`.
  const turn = transcriptFromEntries([entry])[0];
  if (turn === undefined) return undefined;
  return { seq, kind: "message", entryId: entry.id, turn };
}

function recordEvent(
  item: Extract<LogItem, { kind: "record" }>,
  seq: number,
): DurableEvent | undefined {
  const { record } = item;
  switch (record.type) {
    case "operation_started":
      return {
        seq,
        kind: "run_started",
        runId: record.id,
        head: record.head,
        startedAt: record.timestamp,
        operation: record.intent.kind,
        ...(record.config?.agent === undefined ? {} : { agent: record.config.agent }),
      };
    case "operation_finished":
      return {
        seq,
        kind: "run_finished",
        runId: record.runId,
        head: record.head,
        finishedAt: record.timestamp,
        outcome: runEnd(record.outcome, record.error),
      };
    case "queue_enqueued": {
      // Queue targets are admitted user messages; anything else is not a
      // pending item a client can edit, so it projects to nothing.
      if (record.target.message.role !== "user") return undefined;
      return {
        seq,
        kind: "queued",
        item: {
          entryId: record.target.id,
          delivery: record.queue === "followUp" ? "queue" : record.queue,
          content: record.target.message.content,
        },
      };
    }
    case "tool_waiting":
      return {
        seq,
        kind: "run_waiting",
        runId: record.runId,
        head: record.head,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        args: record.effectiveArgs,
      };
    case "queue_consumed":
      return { seq, kind: "queue_consumed", entryId: record.entryId };
    case "queue_cancelled":
      return { seq, kind: "queue_cancelled", entryId: record.entryId };
    default:
      return undefined;
  }
}

function runEnd(
  outcome: "completed" | "aborted" | "failed",
  error: { code: string; message: string } | undefined,
): RunEnd {
  switch (outcome) {
    case "completed":
      return { kind: "completed" };
    case "aborted":
      return { kind: "aborted" };
    case "failed":
      return { kind: "failed", error: { message: error?.message ?? "run failed" } };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
