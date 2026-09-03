/**
 * Session storage model — write-once entries and records over mutable head
 * pointers and facts, one seq counter per session — after pi's harness storage
 * design, scoped to Uji's slice of it.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md
 */
import { randomUUID } from "node:crypto";
import type { JsonValue, Message, ProviderCheckpointMaterial, Usage } from "@uji-ai/schema";
import type { DurableSessionStore, RunClaim, SendOrigin } from "./store.ts";

export type { JsonValue } from "@uji-ai/schema";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Clone a runtime value only if live execution and durable JSON replay are equivalent. */
export function toJsonValue(value: unknown): JsonValue {
  return cloneJsonValue(value, "$", new Set());
}

export function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  /** `false` admits without asking an attached host to run; absent means wake. */
  wake?: false;
}

/** A durable context checkpoint. The transcript remains intact; projection starts here. */
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  /** Plaintext portable checkpoint. Empty when `material` is provider-native. */
  summary: string;
  /** Portable fallback for provider-native material, otherwise the recent unsummarized tail. */
  retainedTail: Message[];
  /** Explicit provider-native replacement context. Never hidden in `details`. */
  material?: ProviderCheckpointMaterial;
  tokensBefore: number;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
  reason?: "manual" | "threshold" | "overflow";
}

/**
 * What an abandoned branch was about, appended at the destination of a
 * navigation. Unlike a compaction it is not a checkpoint: context projection
 * keeps everything before it and adds its summary as one more message.
 */
export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  /** The leaf the head left: the tip of the summarized branch. */
  fromId: string;
  /** The entry the user selected; the abandoned path is measured against it. */
  selectedId: string | null;
  summary: string;
  /** File-operation details (`readFiles`, `modifiedFiles`) captured with the summary. */
  details?: JsonValue;
  usage?: Usage;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  modelId: string;
  /** Catalog namespace for `modelId`. Entries written before it was recorded resolve by id alone. */
  provider?: string;
}

export interface ThinkingLevelEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface AgentChangeEntry extends EntryBase {
  type: "agent_change";
  /** Re-resolved against the running host's registry at run start; the durable artifact is the name. */
  agentId: string;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: JsonValue;
}

export type Entry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ThinkingLevelEntry
  | AgentChangeEntry
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

/**
 * A structural run: re-point the head, optionally leaving a summary of the
 * branch it abandons. `sourceLeafId` on the record is the branch being left.
 */
export interface NavigationIntent {
  kind: "navigation";
  /** The entry the user selected in the tree, or null for the start of the chat. */
  selectedId: string | null;
  /** Where the head lands: the selection itself, or its parent for a user message. */
  targetId: string | null;
  /**
   * Present when the user asked for a summary. The entry id is provisioned
   * here so a resumed operation appends the summary at most once.
   */
  summary?: { entryId: string; customInstructions?: string };
}

type OperationIntent = RunIntent | CompactionIntent | NavigationIntent;

/**
 * The run inputs the tree held when the run started: the latest
 * `model_change` and `thinking_level_change` entries on the branch, folded at
 * admission. Refs, not resolved values: a host resuming the run re-resolves
 * them against its own catalog, so the durable artifact is the name.
 */
export interface RunConfig {
  model?: { provider?: string; id: string };
  thinkingLevel?: string;
  agent?: string;
}

export interface OperationStartedRecord extends RecordBase {
  type: "operation_started";
  sourceLeafId: string | null;
  intent: OperationIntent;
  /** Absent when the branch held no configuration entries at run start. */
  config?: RunConfig;
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
  step: "assistant" | "compaction" | "branch_summary";
  attempt: number;
}

/**
 * A transient provider failure that is owed another attempt. The wake time is durable so a
 * process lost mid-backoff resumes the wait instead of restarting the turn, and a
 * step-at-a-time host can schedule from it (pi harness.md 3.7, `retry_wait`).
 *
 * Only the assistant turn schedules these. The compaction and branch-summary calls retry
 * inside one step, so their attempts never outlive the process that made them.
 */
export interface RetryScheduledRecord extends RecordBase {
  type: "retry_scheduled";
  runId: string;
  /**
   * Which retry this is, 1-based. Distinct from `StepAttemptRecord.attempt`, which counts
   * turns in the run; one turn can hold several retries and a run can retry more than once.
   */
  attempt: number;
  /** Epoch ms. The next attempt must not start before this. */
  notBefore: number;
  /** The failure that caused it, kept so a resumed process can explain the wait. */
  errorMessage: string;
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

/**
 * The tool at `toolCallId` settled as waiting: the run released its claim on
 * purpose and waits for input that arrives by admission. The intent stays open
 * and recovery must not touch the reserved `resultEntryId`; the wake path
 * settles it exactly once. The record carries no payload of its own: a wake
 * re-derives its state from the intent's validated arguments and derived ids.
 */
export interface ToolWaitingRecord extends RecordBase {
  type: "tool_waiting";
  runId: string;
  toolCallId: string;
  toolName: string;
  /** The intent's validated args, so a client renders the ask from this record alone. */
  effectiveArgs: JsonValue;
  resultEntryId: string;
}

/** A participant's answer to one waiting tool call. First writer wins. */
export interface ToolReplyRecord extends RecordBase {
  type: "tool_reply";
  toolCallId: string;
  reply: JsonValue;
}

/**
 * The wake pass saw every wake input up to `throughSeq`. Written at read
 * scope, so input landing mid-wake stays unobserved and wakes again.
 */
export interface ToolWakeObservedRecord extends RecordBase {
  type: "tool_wake_observed";
  runId: string;
  throughSeq: number;
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

/** A queued item entered the conversation: its target entry landed in the tree. */
export interface QueueConsumedRecord extends RecordBase {
  type: "queue_consumed";
  runId: string;
  entryId: string;
}

export interface QueueCancelledRecord extends RecordBase {
  type: "queue_cancelled";
  /** Cancels an unconsumed queue or deferred-write target with this entry id. */
  entryId: string;
}

export interface UsageRecord extends RecordBase {
  type: "usage";
  runId: string;
  cause: "assistant" | "tool" | "compaction" | "branch_summary";
  usage: Usage;
}

export type PendingRunWrite =
  | { kind: "deferred"; record: DeferredWriteRecord }
  | { kind: "steer" | "followUp" | "nextRun"; record: QueueEnqueuedRecord };

type CompactionBookkeeping =
  | { kind: "none"; attempts: number; overflowRecovered: false }
  | {
      kind: "compacted";
      attempts: number;
      overflowRecovered: boolean;
      entry: CompactionEntry;
    };

type NavigationBookkeeping =
  | {
      kind: "pending";
      /** Branch-summary generation attempts recorded for this operation. */
      attempts: number;
    }
  | {
      kind: "summarized";
      attempts: number;
      /** The provisioned summary entry. Its presence settles the model effect. */
      entry: BranchSummaryEntry;
      /** Whether usage for this summary reached the records ledger. */
      usageRecorded: boolean;
    };

/**
 * Assistant retry budget and any owed backoff. `depth` counts retries since the last
 * assistant turn that produced something, so a long run of successful turns never
 * exhausts the budget; a turn that keeps failing does.
 */
type RetryBookkeeping =
  | { kind: "none"; depth: number }
  | { kind: "waiting"; depth: number; record: RetryScheduledRecord };

interface RunStateBase {
  operation: OperationStartedRecord;
  toolIntents: readonly ToolStartedRecord[];
  /** Unsettled intents recovery may act on. Waiting intents are not here. */
  unsettledToolIntents: readonly ToolStartedRecord[];
  /** Active waitingCalls: `tool_waiting` records whose result entry has not landed. */
  waitingCalls: readonly ToolWaitingRecord[];
  /** First reply per call id; later replies for the same call never land. */
  toolReplies: ReadonlyMap<string, ToolReplyRecord>;
  /** Highest `tool_wake_observed.throughSeq`; the wake predicate's cursor. */
  lastWakeObservedSeq: number | null;
  /** Assistant turns started in this run. Not retries: see `retry.depth` for those. */
  turnAttempts: number;
  retry: RetryBookkeeping;
  compaction: CompactionBookkeeping;
  navigation: NavigationBookkeeping;
  pendingWrites: readonly PendingRunWrite[];
  abortRequested: AbortRequestedRecord | undefined;
  /** When the run's newest claim lapses or lapsed; undefined if it was never claimed. */
  lastClaimExpiresAt: number | undefined;
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
  | RetryScheduledRecord
  | ToolStartedRecord
  | ToolWaitingRecord
  | ToolReplyRecord
  | ToolWakeObservedRecord
  | QueueEnqueuedRecord
  | QueueConsumedRecord
  | DeferredWriteRecord
  | QueueCancelledRecord
  | UsageRecord;

/** Records admitted without execution rights. */
export type ParticipantRecord =
  | AbortRequestedRecord
  | ToolReplyRecord
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
  /** `by` is stored at write time: an append-through advance or a deliberate re-point. */
  | { kind: "head"; seq: number; head: string; leafId: string | null; by: "append" | "move" }
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
  /** One ordered read snapshot across entries, records, heads, facts, and claims. */
  getLog(options?: { afterSeq?: number }): Promise<LogItem[]>;
  /** The newest `seq` in the log (0 when empty; the first seq is 1): a watch cursor without reading the log. */
  lastSeq(): Promise<number>;
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
  setName(name: string): Promise<void>;
  /**
   * Write the name only while the current name is exactly `expected`
   * (`undefined`: no name yet). Compare and write are one transaction; a
   * failed compare writes nothing and consumes no seq.
   */
  setNameIfCurrent(expected: string | undefined, next: string): Promise<boolean>;
  /** Append a new value; `undefined` deletes. Facts are append-only, latest wins. */
  setFact(fact: string, value: JsonValue | undefined): Promise<void>;
  close(): Promise<void>;
}

export interface SessionRepo {
  create(options?: { id?: string }): Promise<SessionStorage>;
  open(id: string): Promise<SessionStorage>;
  list(): Promise<SessionMetadata[]>;
  /**
   * Remove a session and everything it owns. The caller settles the session
   * first (abort, wait idle, close handles); the repo only deletes rows.
   * Deleting an unknown id is a no-op: the asked-for state already holds.
   */
  delete(id: string): Promise<void>;
}

type SessionErrorCode = "not_found" | "invalid_entry" | "claim_lost" | "storage";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}
