/**
 * Session storage model — write-once entries and records over mutable lane
 * pointers and facts, one seq counter per session — after pi's harness storage
 * design, scoped to June's slice of it.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md
 */
import { randomUUID } from "node:crypto";
import type { JsonValue, Message, Usage } from "@june/schema";

export type { JsonValue } from "@june/schema";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Clone a runtime value only if live execution and durable JSON replay are equivalent. */
export function toJsonValue(value: unknown): JsonValue {
  return cloneJsonValue(value, "$", new Set());
}

function cloneJsonValue(value: unknown, path: string, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite JSON number`);
    if (Object.is(value, -0))
      throw new TypeError(`${path} cannot be negative zero in durable JSON`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} cannot be represented as JSON`);
  }
  if (seen.has(value)) throw new TypeError(`${path} contains a repeated or circular reference`);

  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || !Object.isExtensible(value)) {
      throw new TypeError(`${path} must be a plain JSON array`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      const index = typeof key === "string" ? Number(key) : Number.NaN;
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
        throw new TypeError(`${path} cannot contain non-index array properties`);
      }
    }
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !descriptor.configurable ||
        !("value" in descriptor) ||
        !descriptor.writable
      ) {
        throw new TypeError(`${path}[${index}] must be a mutable enumerable data property`);
      }
      return cloneJsonValue(descriptor.value, `${path}[${index}]`, seen);
    });
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype || !Object.isExtensible(value)) {
    throw new TypeError(`${path} must be a plain JSON object`);
  }

  const entries: Array<[string, JsonValue]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} cannot contain symbol keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !descriptor.configurable ||
      !("value" in descriptor) ||
      !descriptor.writable
    ) {
      throw new TypeError(`${path}.${key} must be a mutable enumerable data property`);
    }
    entries.push([key, cloneJsonValue(descriptor.value, `${path}.${key}`, seen)]);
  }
  return Object.fromEntries(entries);
}

export interface EntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
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
    originalPrompt: Message[];
    /** nextRun items come first, then the prompt. */
    initialMessages: ProvisionedEntry<MessageEntry>[];
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
  target: ProvisionedEntry<MessageEntry>;
}

export interface QueueCancelledRecord extends RecordBase {
  type: "queue_cancelled";
  entryId: string;
}

export interface UsageRecord extends RecordBase {
  type: "usage";
  runId: string;
  cause: "assistant" | "tool";
  usage: Usage;
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
