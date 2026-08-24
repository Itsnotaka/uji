/**
 * Session storage model — write-once entries and records over mutable head
 * pointers and facts, one seq counter per session — after pi's harness storage
 * design, scoped to Uji's slice of it.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md
 */
import { randomUUID } from "node:crypto";
import type { JsonValue, Message, Usage } from "@uji-ai/schema";
import type { DurableSessionStore, RunClaim, SendOrigin } from "./store.ts";

export type { JsonValue } from "@uji-ai/schema";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Clone a runtime value only if live execution and durable JSON replay are equivalent. */
export function toJsonValue(value: unknown): JsonValue {
  return cloneJsonValue(value, "$", new Set());
}

function isStringKey(key: PropertyKey): key is string {
  return typeof key === "string";
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
      const index = isStringKey(key) ? Number(key) : Number.NaN;
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
    if (!isStringKey(key)) {
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
    // Match JSON.stringify: an undefined property is absent, not an error. Tool
    // prepareArguments routinely return `{ path, offset, limit }` with omitted optionals.
    if (descriptor.value === undefined) continue;
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
  origin?: SendOrigin;
}

/** A durable context checkpoint. The transcript remains intact; projection starts here. */
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  retainedTail: Message[];
  tokensBefore: number;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
  reason?: "manual" | "threshold" | "overflow";
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

export type Entry =
  | MessageEntry
  | CompactionEntry
  | ModelChangeEntry
  | ThinkingLevelEntry
  | CustomEntry;

export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "parentId" | "seq" | "timestamp">
  : never;

export interface RecordBase {
  id: string;
  seq: number;
  head: string;
  timestamp: number;
}

export interface RunIntent {
  kind: "run";
  originalPrompt: Message[];
  /** nextRun items come first, then the prompt. */
  initialMessages: ProvisionedEntry<MessageEntry>[];
  /** A steer-only wake leaves explicit follow-up delivery parked for a later run. */
  promotionScope?: "steer";
}

export interface CompactionIntent {
  kind: "compaction";
  customInstructions?: string;
}

export interface OperationStartedRecord extends RecordBase {
  type: "operation_started";
  sourceLeafId: string | null;
  intent: RunIntent | CompactionIntent;
}

export interface AbortRequestedRecord extends RecordBase {
  type: "abort_requested";
  runId: string;
  /** Wake pending steers after the aborted run settles. */
  continueSteers?: boolean;
}

export interface OperationFinishedRecord extends RecordBase {
  type: "operation_finished";
  runId: string;
  outcome: "completed" | "aborted" | "failed";
  leafId?: string | null;
  error?: { code: string; message: string };
}

export interface StepAttemptRecord extends RecordBase {
  type: "step_attempt";
  runId: string;
  step: "assistant" | "compaction";
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

/** A participant tree write held behind a live run and applied at its next checkpoint. */
export interface DeferredWriteRecord extends RecordBase {
  type: "deferred_write";
  runId: string;
  target: ProvisionedEntry;
}

export interface QueueCancelledRecord extends RecordBase {
  type: "queue_cancelled";
  /** Cancels an unconsumed queue or deferred-write target with this entry id. */
  entryId: string;
}

export interface UsageRecord extends RecordBase {
  type: "usage";
  runId: string;
  cause: "assistant" | "tool" | "compaction";
  usage: Usage;
}

export type PendingRunWrite =
  | { kind: "deferred"; record: DeferredWriteRecord }
  | { kind: "steer" | "followUp" | "nextRun"; record: QueueEnqueuedRecord };

export type CompactionBookkeeping =
  | { kind: "none"; attempts: number; overflowRecovered: false }
  | {
      kind: "compacted";
      attempts: number;
      overflowRecovered: boolean;
      entry: CompactionEntry;
    };

interface RunStateBase {
  operation: OperationStartedRecord;
  lastStepAttempt: StepAttemptRecord | undefined;
  toolIntents: readonly ToolStartedRecord[];
  unsettledToolIntents: readonly ToolStartedRecord[];
  highestConsumedQueueSeq: number | null;
  retryCount: number;
  compaction: CompactionBookkeeping;
  pendingWrites: readonly PendingRunWrite[];
  abortRequested: AbortRequestedRecord | undefined;
}

export type RunState =
  | { kind: "missing"; runId: string }
  | ({ kind: "running" } & RunStateBase)
  | ({ kind: "finished"; finished: OperationFinishedRecord } & RunStateBase);

export type SessionRecord =
  | OperationStartedRecord
  | AbortRequestedRecord
  | OperationFinishedRecord
  | StepAttemptRecord
  | ToolStartedRecord
  | QueueEnqueuedRecord
  | DeferredWriteRecord
  | QueueCancelledRecord
  | UsageRecord;

/** Records admitted without execution rights. */
export type ParticipantRecord =
  | AbortRequestedRecord
  | QueueEnqueuedRecord
  | DeferredWriteRecord
  | QueueCancelledRecord;

/** Records that advance a run and therefore require a fenced RunWriter. */
export type RunRecord = Exclude<SessionRecord, ParticipantRecord>;

export type NewRecord<TRecord extends SessionRecord = SessionRecord> = TRecord extends SessionRecord
  ? Omit<TRecord, "seq" | "timestamp">
  : never;

export type ClaimLogEvent =
  | { kind: "acquired" | "renewed"; claim: RunClaim }
  | {
      kind: "released";
      head: string;
      runId: string;
      ownerId: string;
      fence: number;
    };

export type LogItem =
  | { kind: "entry"; seq: number; head: string; entry: Entry }
  | { kind: "record"; seq: number; record: SessionRecord }
  | { kind: "head"; seq: number; head: string; leafId: string | null }
  | { kind: "fact"; seq: number; fact: "name"; name: string }
  | { kind: "fact_value"; seq: number; fact: string; value: JsonValue | undefined }
  | { kind: "claim"; seq: number; event: ClaimLogEvent };

export interface SessionMetadata {
  id: string;
  createdAt: number;
}

export interface EntryQuery {
  type?: Entry["type"];
  limit?: number;
}

export interface RecordQuery {
  type?: SessionRecord["type"];
  runId?: string;
  afterSeq?: number;
}

/**
 * Entries and records are write-once; head pointers and facts are the mutable
 * registers. One `seq` per session orders all four, so a backend cannot give
 * each table its own counter without breaking getLog and every afterSeq cursor.
 */
export interface SessionStorage extends DurableSessionStore {
  getMetadata(): Promise<SessionMetadata>;
  getEntry(id: string): Promise<Entry | undefined>;
  getLeafId(head: string): Promise<string | null>;
  /** Oldest first. */
  getBranch(head: string): Promise<Entry[]>;
  findEntries(query?: EntryQuery): Promise<Entry[]>;
  findRecords<K extends SessionRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<SessionRecord, { type: K }>[]>;
  /**
   * Newest first; callers resume the first result. At most one operation can be
   * open on a head, so more than one means the log is corrupt.
   */
  findOpenOperations(head: string): Promise<OperationStartedRecord[]>;
  /** Everything a runner needs to continue one durable step, projected from the log. */
  runState(runId: string): Promise<RunState>;
  getLog(options?: { afterSeq?: number }): Promise<LogItem[]>;
  getName(): Promise<string | undefined>;
  /** Latest value of a fact, or undefined if never set or deleted. */
  getFact(fact: string): Promise<JsonValue | undefined>;
  /** Latest value of every fact whose name starts with `prefix`, deleted facts omitted. */
  listFacts(prefix: string): Promise<{ fact: string; value: JsonValue }[]>;
  /**
   * Strict low-level tree write for an idle head. It throws `invalid_entry`
   * when a live claim exists. Participant code that may race a run must use
   * `admitEntry`, which defers safely (design record: "Admission is open").
   */
  appendEntry(entry: ProvisionedEntry, head: string): Promise<Entry>;
  /**
   * Strict low-level batch form of `appendEntry`; every target is written in
   * one transaction only when the head is idle.
   */
  appendEntries(entries: readonly ProvisionedEntry[], head: string): Promise<Entry[]>;
  appendRecord<TRecord extends ParticipantRecord>(record: NewRecord<TRecord>): Promise<TRecord>;
  moveHead(head: string, to: string | null): Promise<void>;
  setName(name: string): Promise<void>;
  /** Append a new value; `undefined` deletes. Facts are append-only, latest wins. */
  setFact(fact: string, value: JsonValue | undefined): Promise<void>;
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

export type SessionErrorCode = "not_found" | "invalid_entry" | "claim_lost" | "storage";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}
