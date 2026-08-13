import { randomUUID } from "node:crypto";
import type { ResponseItem } from "@june/schema";
import type { TurnUsage } from "../../agent-loop.ts";

export type { TurnUsage };

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface EntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: ResponseItem;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  modelId: string;
}

export interface ThinkingLevelEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export type Entry = MessageEntry | ModelChangeEntry | ThinkingLevelEntry | CustomEntry;

export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "parentId" | "seq" | "timestamp">
  : never;

export interface RecordBase {
  id: string;
  seq: number;
  lane: string;
  timestamp: number;
}

export interface OperationStartedRecord extends RecordBase {
  type: "operation_started";
  sourceLeafId: string | null;
  intent: {
    kind: "run";
    originalPrompt: ResponseItem[];
    /** nextRun items come first, then the prompt. */
    initialMessages: ProvisionedEntry[];
  };
}

export interface AbortRequestedRecord extends RecordBase {
  type: "abort_requested";
  runId: string;
}

export interface OperationFinishedRecord extends RecordBase {
  type: "operation_finished";
  runId: string;
  outcome: "completed" | "aborted" | "failed";
  error?: { code: string; message: string };
}

export interface StepAttemptRecord extends RecordBase {
  type: "step_attempt";
  runId: string;
  step: "assistant";
  attempt: number;
}

/**
 * Must be committed before the tool executes. After a crash, a record whose
 * `resultEntryId` has no entry is an unsettled effect: `replay` decides whether
 * it re-runs or fails.
 */
export interface ToolStartedRecord extends RecordBase {
  type: "tool_started";
  runId: string;
  toolCallId: string;
  toolName: string;
  effectiveArgs: JsonValue;
  resultEntryId: string;
  replay: "never" | "safe";
}

export interface QueueEnqueuedRecord extends RecordBase {
  type: "queue_enqueued";
  queue: "steer" | "followUp" | "nextRun";
  runId?: string;
  target: ProvisionedEntry;
}

export interface QueueCancelledRecord extends RecordBase {
  type: "queue_cancelled";
  entryId: string;
}

export interface UsageRecord extends RecordBase {
  type: "usage";
  runId: string;
  cause: "assistant" | "tool";
  usage: TurnUsage;
}

export type LaneRecord =
  | OperationStartedRecord
  | AbortRequestedRecord
  | OperationFinishedRecord
  | StepAttemptRecord
  | ToolStartedRecord
  | QueueEnqueuedRecord
  | QueueCancelledRecord
  | UsageRecord;

export type NewRecord<TRecord extends LaneRecord = LaneRecord> = TRecord extends LaneRecord
  ? Omit<TRecord, "seq" | "timestamp">
  : never;

export type LogItem =
  | { kind: "entry"; seq: number; lane: string; entry: Entry }
  | { kind: "record"; seq: number; record: LaneRecord }
  | { kind: "lane"; seq: number; lane: string; leafId: string | null }
  | { kind: "fact"; seq: number; fact: "name"; name: string };

export interface SessionMetadata {
  id: string;
  createdAt: number;
}

export interface EntryQuery {
  type?: Entry["type"];
  limit?: number;
}

export interface RecordQuery {
  type?: LaneRecord["type"];
  runId?: string;
  afterSeq?: number;
}

/**
 * Entries and records are write-once; lane pointers and facts are the mutable
 * registers. One `seq` per session orders all four, so a backend cannot give
 * each table its own counter without breaking getLog and every afterSeq cursor.
 */
export interface SessionStorage {
  getMetadata(): Promise<SessionMetadata>;
  /** Parents the entry on the lane leaf, then advances the lane to it. */
  appendEntry(entry: ProvisionedEntry, lane: string): Promise<Entry>;
  appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord>;
  getEntry(id: string): Promise<Entry | undefined>;
  getLeafId(lane: string): Promise<string | null>;
  moveLane(lane: string, to: string | null): Promise<void>;
  /** Oldest first. */
  getBranch(lane: string): Promise<Entry[]>;
  findEntries(query?: EntryQuery): Promise<Entry[]>;
  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  /**
   * Newest first; callers resume the first result. At most one operation can be
   * open on a lane, so more than one means the log is corrupt.
   */
  findOpenOperations(lane: string): Promise<OperationStartedRecord[]>;
  getLog(options?: { afterSeq?: number }): Promise<LogItem[]>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionRepo {
  create(options?: { id?: string }): Promise<SessionStorage>;
  open(id: string): Promise<SessionStorage>;
  list(): Promise<SessionMetadata[]>;
}

export interface SessionSearchHit {
  sessionId: string;
  entryId: string;
  timestamp: number;
  snippet: string;
  /** Lower scores rank better. */
  score: number;
}

export interface SessionSearch {
  searchEntries(
    text: string,
    options?: { limit?: number; type?: Entry["type"] },
  ): Promise<SessionSearchHit[]>;
}

export type SessionErrorCode = "not_found" | "invalid_entry" | "storage";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}
