/**
 * Durable session storage contract, ported from pi-agent-core
 * harness/session/types.ts and trimmed to June's current slice: entries are a
 * write-once tree, records are the append-only operation/effect ledger, lane
 * pointers and facts complete the log. One total `seq` orders everything.
 *
 * June deviations (recorded): AgentMessage → ResponseItem wire; no
 * compaction/branch_summary entries, navigation intents, write_deferred,
 * labels, or fork yet — they compose onto this same log later.
 */
import type { ResponseItem } from "@june/schema";
import type { TurnUsage } from "../../agent-loop.ts";

export type { TurnUsage };

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

/** An entry authored before commit: storage assigns parentId/seq/timestamp. */
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
    /** Normalized caller input, kept for suspended-operation resume. */
    originalPrompt: ResponseItem[];
    /** Provisioned prompt entries (nextRun items first, then the prompt). */
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
 * The intent half of the effect sandwich: committed before a tool executes.
 * `resultEntryId` provisions where the settlement entry will land; a
 * tool_started record with no entry at that id after a crash is an unsettled
 * effect, resolved by `replay` ("safe" re-executes, "never" fails the call).
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

/** App-owned durable storage. Everything the harness persists goes through here. */
export interface SessionStorage {
  getMetadata(): Promise<SessionMetadata>;
  /** Append an entry to a lane: parent = lane leaf; the lane pointer advances. */
  appendEntry(entry: ProvisionedEntry, lane: string): Promise<Entry>;
  appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord>;
  getEntry(id: string): Promise<Entry | undefined>;
  getLeafId(lane: string): Promise<string | null>;
  /** Entries from the branch root to the lane leaf, oldest first. */
  getBranch(lane: string): Promise<Entry[]>;
  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  /**
   * Unfinished operation starts, newest first. Zero results = idle; one =
   * suspended; two or more = corruption.
   */
  findOpenOperations(lane: string): Promise<OperationStartedRecord[]>;
  getLog(options?: { afterSeq?: number }): Promise<LogItem[]>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;
}

export interface SessionRepo {
  create(options?: { id?: string }): Promise<SessionStorage>;
  open(id: string): Promise<SessionStorage>;
  list(): Promise<SessionMetadata[]>;
}

export type SessionErrorCode = "not_found" | "invalid_entry" | "storage";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}
