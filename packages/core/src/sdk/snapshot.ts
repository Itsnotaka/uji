import { readSessionConfig } from "../harness/session/context.ts";
import type { Entry, JsonValue, LogItem, SessionMetadata } from "../harness/session/types.ts";
import { isThinkingLevel } from "../types.ts";
import { sessionDirectoryEntryFromLog } from "../views/directory.ts";
import {
  MAIN,
  sessionId,
  type HeadInfo,
  type HeadName,
  type PendingItem,
  type SessionInfo,
  type SessionParent,
} from "./types.ts";

export const PARENT_FACT = "parent";

export function parentFromFact(value: JsonValue | undefined): SessionParent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { sessionId: parentId, runId, callId, agent, depth } = value;
  if (
    typeof parentId !== "string" ||
    typeof runId !== "string" ||
    typeof callId !== "string" ||
    typeof agent !== "string" ||
    typeof depth !== "number"
  ) {
    return undefined;
  }
  return { sessionId: sessionId(parentId), runId, callId, agent, depth };
}

/** The parent link, from the log's fact values. */
function parentFromLog(log: readonly LogItem[]): SessionParent | undefined {
  let parent: SessionParent | undefined;
  for (const item of log) {
    if (item.kind === "fact_value" && item.fact === PARENT_FACT) parent = parentFromFact(item.value);
  }
  return parent;
}

/** Every head the log names, with its current leaf; `main` exists even before its first entry. */
export function headLeaves(log: readonly LogItem[]): Map<HeadName, string | null> {
  const leaves = new Map<HeadName, string | null>([[MAIN, null]]);
  for (const item of log) {
    if (item.kind === "head") leaves.set(item.head, item.leafId);
  }
  return leaves;
}

/**
 * The session row. Run state comes from the caller because it reads the live
 * claim, which is wall-clock and a store verb, not a log fold.
 */
export function sessionInfoFromLog(input: {
  readonly metadata: SessionMetadata;
  readonly log: readonly LogItem[];
  readonly heads: readonly HeadInfo[];
  readonly mainBranch: readonly Entry[];
}): SessionInfo {
  const row = sessionDirectoryEntryFromLog(input);
  const declared = readSessionConfig(input.mainBranch);
  const parent = parentFromLog(input.log);
  return {
    sessionId: sessionId(input.metadata.id),
    name: row.name,
    preview: row.preview,
    createdAt: input.metadata.createdAt,
    lastActivityAt: row.lastActivity,
    heads: input.heads,
    config: {
      ...(declared.model === undefined ? {} : { model: declared.model }),
      ...(declared.thinkingLevel !== undefined && isThinkingLevel(declared.thinkingLevel)
        ? { thinkingLevel: declared.thinkingLevel }
        : {}),
      ...(declared.agent === undefined ? {} : { agent: declared.agent }),
    },
    ...(parent === undefined ? {} : { parent }),
  };
}

/** Pending queue projection without activating the session's plugin harness. */
export function pendingItemsFromLog(log: readonly LogItem[]): readonly PendingItem[] {
  const entries = new Set<string>();
  const cancelled = new Set<string>();
  const latestByEntry = new Map<
    string,
    Extract<Extract<LogItem, { kind: "record" }>["record"], { type: "queue_enqueued" }>
  >();

  for (const item of log) {
    if (item.kind === "entry") {
      entries.add(item.entry.id);
      continue;
    }
    if (item.kind !== "record") continue;
    if (item.record.type === "queue_enqueued") {
      latestByEntry.set(item.record.target.id, item.record);
    } else if (item.record.type === "queue_cancelled") {
      cancelled.add(item.record.entryId);
    }
  }

  const pending: PendingItem[] = [];
  for (const record of latestByEntry.values()) {
    if (entries.has(record.target.id) || cancelled.has(record.target.id)) continue;
    const { message } = record.target;
    if (message.role !== "user") continue;
    pending.push({
      entryId: record.target.id,
      delivery: record.queue === "followUp" ? "queue" : record.queue,
      content: message.content,
    });
  }
  return pending;
}
