import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { joinSqlFragments, sql } from "./sql.ts";
import { projectRunState } from "./run-state.ts";
import {
  RUN_CLAIMS_SCHEMA,
  acquireRunClaim,
  readLiveClaim,
  releaseRunClaim,
  renewRunClaim,
  type ClaimRunOutcome,
  type EntryAdmission,
  type RunClaim,
  type RunWriter,
  type SendOptions,
  type SendOrigin,
  type SendReceipt,
  type WatchOptions,
} from "./store.ts";
import {
  newId,
  SessionError,
  toJsonValue,
  type ClaimLogEvent,
  type DeferredWriteRecord,
  type Entry,
  type EntryQuery,
  type JsonValue,
  type SessionRecord,
  type LogItem,
  type MessageEntry,
  type NewRecord,
  type OperationFinishedRecord,
  type OperationStartedRecord,
  type ParticipantRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type RunRecord,
  type RunState,
  type SessionMetadata,
  type SessionRepo,
  type SessionSearch,
  type SessionSearchHit,
  type SessionStorage,
} from "./types.ts";

/**
 * SQLite session backend, after pi's sqlite-node backend and the storage model
 * in harness.md Part 1: entries and records are write-once rows, head pointers
 * and facts are the only mutable state, and one per-session `seq` counter
 * orders all of them. As in pi, one database file holds every session, keyed
 * by session_id — which also gives SessionSearch one FTS index across sessions.
 *
 * The schema is structural only; validating payload shapes is the session
 * layer's job before a write is admitted. Two decisions are load-bearing:
 *
 * - Every writing transaction opens with BEGIN IMMEDIATE. Each one reads
 *   `next_seq` before writing it, and a deferred BEGIN that reads first takes a
 *   snapshot it may fail to upgrade to a write lock — a failure `busy_timeout`
 *   cannot rescue, because waiting never refreshes a stale snapshot.
 * - Participant writes rely on that transaction serialization alone. Runner
 *   writes additionally renew a head-scoped run claim before touching data,
 *   so a stale runner is fenced without making the whole session exclusive.
 *
 * Based on https://github.com/earendil-works/pi/tree/main/packages/session-backends/sqlite-node
 * and https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md
 */

/**
 * The strings the SQL below matches on, tied to their types so a rename in
 * types.ts is a compile error here instead of a silently empty query.
 */
const OPERATION_STARTED: OperationStartedRecord["type"] = "operation_started";
const OPERATION_FINISHED: OperationFinishedRecord["type"] = "operation_finished";
const FACT_NAME: Extract<LogItem, { kind: "fact" }>["fact"] = "name";
/** Generic facts store JSON; deletion uses an out-of-band marker so latest-wins still works. */
const FACT_DELETED = "\u0000deleted";
function encodeFact(value: JsonValue | undefined): string {
  return value === undefined ? FACT_DELETED : JSON.stringify(value);
}
function decodeFact(raw: string): JsonValue | undefined {
  // SAFETY: facts are only written by encodeFact, which stringifies a JsonValue.
  return raw === FACT_DELETED ? undefined : (JSON.parse(raw) as JsonValue);
}

/** Decode a stored entry/record payload back to the type it was written as. */
function readPayload<T>(row: { payload: string }): T {
  // SAFETY: payload columns are only written by appendEntry/appendRecord, which
  // stringify the fully typed value; the caller names the same row type it queried.
  return JSON.parse(row.payload) as T;
}

function runIdOf(record: NewRecord<SessionRecord>): string | null {
  if (record.type === OPERATION_STARTED) return record.id;
  return "runId" in record ? (record.runId ?? null) : null;
}

const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_CLAIM_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_WATCH_POLL_INTERVAL_MS = 25;

interface RunClaimOptions {
  ttlMs: number;
  heartbeatIntervalMs: number;
}

function resolveRunClaimOptions(options?: SqliteSessionRepoOptions): RunClaimOptions {
  const ttlMs = options?.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const heartbeatIntervalMs =
    options?.claimHeartbeatIntervalMs ?? DEFAULT_CLAIM_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("claimTtlMs must be positive");
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    heartbeatIntervalMs >= ttlMs
  ) {
    throw new RangeError("claimHeartbeatIntervalMs must be positive and less than claimTtlMs");
  }
  return { ttlMs, heartbeatIntervalMs };
}

function resolveWatchPollIntervalMs(options?: SqliteSessionRepoOptions): number {
  const intervalMs = options?.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new RangeError("watchPollIntervalMs must be positive");
  }
  return intervalMs;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  next_seq INTEGER NOT NULL
) WITHOUT ROWID;

-- Keeps its rowid: entries_fts is an external-content index over this table.
CREATE TABLE IF NOT EXISTS entries (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT,
  head TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_entries_type_seq ON entries(session_id, type, seq);

CREATE TABLE IF NOT EXISTS records (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  head TEXT NOT NULL,
  type TEXT NOT NULL,
  -- Denormalized from the payload so run-scoped queries can use an index; an
  -- operation_started record is its own run.
  run_id TEXT,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_records_type_seq ON records(session_id, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_head_type_seq ON records(session_id, head, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_run_seq ON records(session_id, run_id, seq);

CREATE TABLE IF NOT EXISTS heads (
  session_id TEXT NOT NULL,
  head TEXT NOT NULL,
  leaf_id TEXT,
  PRIMARY KEY (session_id, head)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS head_moves (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  head TEXT NOT NULL,
  leaf_id TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS facts (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  fact TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

${RUN_CLAIMS_SCHEMA}

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  payload,
  content = 'entries',
  content_rowid = 'rowid',
  tokenize = 'trigram remove_diacritics 1'
);
-- Insert-only: entries are write-once, so the index never needs update or
-- delete triggers.
CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
`;

/**
 * Runs `fn` inside BEGIN IMMEDIATE, committing on return and rolling back on
 * throw. See the module comment for why the transaction must not be deferred.
 */
function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed COMMIT has already rolled back.
    }
    throw error;
  }
}

interface EntryRow {
  seq: number;
  head: string;
  payload: string;
}

interface RecordRow {
  seq: number;
  payload: string;
}

interface ClaimEventRow {
  seq: number;
  head: string;
  run_id: string;
  owner_id: string;
  fence: number;
  expires_at_ms: number | null;
  action: string;
}

function claimLogItem(row: ClaimEventRow): LogItem {
  switch (row.action) {
    case "acquired":
    case "renewed":
      if (row.expires_at_ms === null) {
        throw new SessionError("storage", `${row.action} claim event has no expiry`);
      }
      return {
        kind: "claim",
        seq: row.seq,
        event: {
          kind: row.action,
          claim: {
            head: row.head,
            runId: row.run_id,
            ownerId: row.owner_id,
            fence: row.fence,
            expiresAtMs: row.expires_at_ms,
          },
        },
      };
    case "released":
      return {
        kind: "claim",
        seq: row.seq,
        event: {
          kind: "released",
          head: row.head,
          runId: row.run_id,
          ownerId: row.owner_id,
          fence: row.fence,
        },
      };
    default:
      throw new SessionError("storage", `Unknown claim event action: ${row.action}`);
  }
}

function readLeafId(db: DatabaseSync, sessionId: string, head: string): string | null {
  const row = sql`SELECT leaf_id FROM heads
    WHERE session_id = ${sessionId} AND head = ${head}`.get<{ leaf_id: string | null }>(db);
  return row?.leaf_id ?? null;
}

function entryExists(db: DatabaseSync, sessionId: string, id: string): boolean {
  return (
    sql`SELECT 1 FROM entries WHERE session_id = ${sessionId} AND id = ${id}`.get(db) !== undefined
  );
}

/** One counter orders entries, records, head moves, and facts. */
function allocateSeq(db: DatabaseSync, sessionId: string, count: number): number {
  const row = sql`SELECT next_seq FROM sessions WHERE id = ${sessionId}`.get<{
    next_seq: number;
  }>(db);
  if (row === undefined) {
    throw new SessionError("not_found", `Session not found: ${sessionId}`);
  }
  sql`UPDATE sessions SET next_seq = ${row.next_seq + count} WHERE id = ${sessionId}`.run(db);
  return row.next_seq;
}

function writeClaimEvent(db: DatabaseSync, sessionId: string, event: ClaimLogEvent): void {
  const seq = allocateSeq(db, sessionId, 1);
  switch (event.kind) {
    case "acquired":
    case "renewed":
      sql`INSERT INTO run_claim_events
          (session_id, seq, head, run_id, owner_id, fence, expires_at_ms, action)
        VALUES (${sessionId}, ${seq}, ${event.claim.head}, ${event.claim.runId},
                ${event.claim.ownerId}, ${event.claim.fence}, ${event.claim.expiresAtMs},
                ${event.kind})`.run(db);
      return;
    case "released":
      sql`INSERT INTO run_claim_events
          (session_id, seq, head, run_id, owner_id, fence, expires_at_ms, action)
        VALUES (${sessionId}, ${seq}, ${event.head}, ${event.runId}, ${event.ownerId},
                ${event.fence}, ${null}, ${event.kind})`.run(db);
      return;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }
}

/**
 * Heartbeat renewal: extends the claim and records a durable `renewed` event so
 * log-only observers get a bounded-cadence liveness signal. The per-write
 * fencing renewal inside RunWriter.write deliberately does NOT come through
 * here — logging every write's renewal would add a row and a seq to every run
 * write forever, for a signal the write's own log items already carry.
 */
function renewClaim(
  db: DatabaseSync,
  sessionId: string,
  claim: RunClaim,
  expiresAtMs: number,
): boolean {
  if (!renewRunClaim(db, sessionId, claim, expiresAtMs)) return false;
  writeClaimEvent(db, sessionId, {
    kind: "renewed",
    claim: { ...claim, expiresAtMs },
  });
  return true;
}

function releaseClaim(db: DatabaseSync, sessionId: string, claim: RunClaim): void {
  if (!releaseRunClaim(db, sessionId, claim)) return;
  writeClaimEvent(db, sessionId, {
    kind: "released",
    head: claim.head,
    runId: claim.runId,
    ownerId: claim.ownerId,
    fence: claim.fence,
  });
}

function writeHeadMove(
  db: DatabaseSync,
  sessionId: string,
  seq: number,
  head: string,
  leafId: string | null,
): void {
  sql`INSERT INTO head_moves (session_id, seq, head, leaf_id)
    VALUES (${sessionId}, ${seq}, ${head}, ${leafId})`.run(db);
  sql`INSERT INTO heads (session_id, head, leaf_id) VALUES (${sessionId}, ${head}, ${leafId})
    ON CONFLICT(session_id, head) DO UPDATE SET leaf_id = excluded.leaf_id`.run(db);
}

function writeEntry(
  db: DatabaseSync,
  sessionId: string,
  entry: ProvisionedEntry,
  head: string,
): Entry {
  if (entryExists(db, sessionId, entry.id)) {
    throw new SessionError("invalid_entry", `Entry id already exists: ${entry.id}`);
  }
  const seq = allocateSeq(db, sessionId, 2);
  // SAFETY: ProvisionedEntry is Entry minus exactly the three fields added here.
  const full = {
    ...entry,
    parentId: readLeafId(db, sessionId, head),
    seq,
    timestamp: Date.now(),
  } as Entry;
  const payload = JSON.stringify(toJsonValue(full));
  sql`INSERT INTO entries (session_id, seq, id, parent_id, head, type, timestamp, payload)
    VALUES (${sessionId}, ${seq}, ${full.id}, ${full.parentId}, ${head}, ${full.type},
            ${full.timestamp}, ${payload})`.run(db);
  writeHeadMove(db, sessionId, seq + 1, head, full.id);
  return full;
}

function writeRecord<TRecord extends SessionRecord>(
  db: DatabaseSync,
  sessionId: string,
  record: NewRecord<TRecord>,
): TRecord {
  const seq = allocateSeq(db, sessionId, 1);
  // SAFETY: NewRecord<TRecord> is TRecord minus exactly the two fields added here;
  // TS cannot relate a generic Omit back to its parameter, hence the two-step cast.
  const full = { ...record, seq, timestamp: Date.now() } as unknown as TRecord;
  const payload = JSON.stringify(toJsonValue(full));
  sql`INSERT INTO records (session_id, seq, id, head, type, run_id, timestamp, payload)
    VALUES (${sessionId}, ${seq}, ${record.id}, ${record.head}, ${record.type},
            ${runIdOf(record)}, ${full.timestamp}, ${payload})`.run(db);
  return full;
}

function assertParticipantRecord(record: NewRecord<SessionRecord>): void {
  switch (record.type) {
    case "abort_requested":
    case "queue_enqueued":
    case "deferred_write":
    case "queue_cancelled":
      return;
    case "operation_started":
    case "operation_finished":
    case "step_attempt":
    case "tool_started":
    case "usage":
      throw new SessionError("invalid_entry", `${record.type} must be written through a run claim`);
    default: {
      const _exhaustive: never = record;
      void _exhaustive;
      throw new SessionError("invalid_entry", "Unknown participant record type");
    }
  }
}

function assertRunRecord(record: NewRecord<SessionRecord>): void {
  switch (record.type) {
    case "operation_started":
    case "operation_finished":
    case "step_attempt":
    case "tool_started":
    case "usage":
      return;
    case "abort_requested":
    case "queue_enqueued":
    case "deferred_write":
    case "queue_cancelled":
      throw new SessionError("invalid_entry", `${record.type} is a participant record`);
    default: {
      const _exhaustive: never = record;
      void _exhaustive;
      throw new SessionError("invalid_entry", "Unknown run record type");
    }
  }
}

function pendingDeferredWrites(
  db: DatabaseSync,
  sessionId: string,
  head: string,
): DeferredWriteRecord[] {
  const rows = sql`SELECT payload FROM records
    WHERE session_id = ${sessionId} AND head = ${head} AND type = ${"deferred_write"}
    ORDER BY seq`.all<RecordRow>(db);
  const cancelled = new Set(
    sql`SELECT payload FROM records
      WHERE session_id = ${sessionId} AND type = ${"queue_cancelled"}`
      .all<RecordRow>(db)
      .map((row) => readPayload<Extract<SessionRecord, { type: "queue_cancelled" }>>(row).entryId),
  );
  const seen = new Set<string>();
  const pending: DeferredWriteRecord[] = [];
  for (const row of rows) {
    const record = readPayload<DeferredWriteRecord>(row);
    if (seen.has(record.target.id)) continue;
    seen.add(record.target.id);
    if (cancelled.has(record.target.id)) continue;
    if (entryExists(db, sessionId, record.target.id)) continue;
    pending.push(record);
  }
  return pending;
}

function applyDeferredWrites(db: DatabaseSync, sessionId: string, head: string): Entry[] {
  return pendingDeferredWrites(db, sessionId, head).map((record) =>
    writeEntry(db, sessionId, record.target, head),
  );
}

function moveHead(db: DatabaseSync, sessionId: string, head: string, to: string | null): void {
  if (to !== null && !entryExists(db, sessionId, to)) {
    throw new SessionError("not_found", `Entry not found: ${to}`);
  }
  writeHeadMove(db, sessionId, allocateSeq(db, sessionId, 1), head, to);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSendReceipt(raw: string): SendReceipt {
  const value: unknown = JSON.parse(raw);
  if (
    !isObject(value) ||
    typeof value.entryId !== "string" ||
    typeof value.duplicate !== "boolean"
  ) {
    throw new SessionError("storage", "Stored send receipt is invalid");
  }
  if (value.disposition === "placed") {
    return { disposition: "placed", entryId: value.entryId, duplicate: true };
  }
  if (value.disposition === "queued" && typeof value.runId === "string") {
    return {
      disposition: "queued",
      entryId: value.entryId,
      runId: value.runId,
      duplicate: true,
    };
  }
  throw new SessionError("storage", "Stored send receipt has an unknown disposition");
}

function normalizeOrigin(origin: SendOrigin | undefined): SendOrigin | undefined {
  if (origin === undefined) return undefined;
  for (const value of [origin.clientId, origin.userId, origin.device]) {
    if (value !== undefined && typeof value !== "string") {
      throw new SessionError("invalid_entry", "Send origin fields must be strings");
    }
  }
  return {
    ...(origin.clientId === undefined ? {} : { clientId: origin.clientId }),
    ...(origin.userId === undefined ? {} : { userId: origin.userId }),
    ...(origin.device === undefined ? {} : { device: origin.device }),
  };
}

class ChangeSubscription {
  private pending = false;
  private resolver: (() => void) | undefined;
  private stopped = false;
  private readonly abortListeners: Array<[AbortSignal, () => void]> = [];
  private readonly onClose: () => void;
  readonly sessionId: string;

  constructor(sessionId: string, signals: readonly AbortSignal[], onClose: () => void) {
    this.sessionId = sessionId;
    this.onClose = onClose;
    if (signals.some((signal) => signal.aborted)) {
      this.stopped = true;
      return;
    }
    for (const signal of signals) {
      const listener = (): void => this.close();
      this.abortListeners.push([signal, listener]);
      signal.addEventListener("abort", listener, { once: true });
    }
  }

  get closed(): boolean {
    return this.stopped;
  }

  wake(): void {
    if (this.stopped) return;
    const resolve = this.resolver;
    if (resolve === undefined) {
      this.pending = true;
      return;
    }
    this.resolver = undefined;
    resolve();
  }

  wait(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [signal, listener] of this.abortListeners) {
      signal.removeEventListener("abort", listener);
    }
    this.abortListeners.length = 0;
    const resolve = this.resolver;
    this.resolver = undefined;
    resolve?.();
    this.onClose();
  }
}

/** Wakes local watchers immediately and polls data_version only while one exists. */
class SqliteChangeTracker {
  private readonly db: DatabaseSync;
  private readonly pollIntervalMs: number;
  private readonly subscriptions = new Set<ChangeSubscription>();
  private dataVersion: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(db: DatabaseSync, pollIntervalMs: number) {
    this.db = db;
    this.pollIntervalMs = pollIntervalMs;
  }

  subscribe(sessionId: string, signals: readonly AbortSignal[]): ChangeSubscription {
    let subscription: ChangeSubscription;
    subscription = new ChangeSubscription(sessionId, signals, () => {
      this.subscriptions.delete(subscription);
      if (this.subscriptions.size === 0 && this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.dataVersion = undefined;
      }
    });
    if (!this.closed && !subscription.closed) {
      this.subscriptions.add(subscription);
      this.startPolling();
    }
    return subscription;
  }

  notify(sessionId: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.sessionId === sessionId) subscription.wake();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const subscription of [...this.subscriptions]) subscription.close();
  }

  private startPolling(): void {
    if (this.timer !== undefined || this.closed || this.subscriptions.size === 0) return;
    if (this.dataVersion === undefined) this.dataVersion = this.readDataVersion();
    this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  private poll(): void {
    this.timer = undefined;
    if (this.closed || this.subscriptions.size === 0) return;
    try {
      const next = this.readDataVersion();
      if (this.dataVersion !== next) {
        this.dataVersion = next;
        for (const subscription of this.subscriptions) subscription.wake();
      }
    } catch {
      // A transient read failure is retried. Cursor queries still prevent gaps.
    } finally {
      this.startPolling();
    }
  }

  private readDataVersion(): number {
    const row = sql`PRAGMA data_version`.get<{ data_version: number }>(this.db);
    if (row === undefined) throw new SessionError("storage", "Could not read data_version");
    return row.data_version;
  }
}

/** The one SQLite session handle: reads, participant writes, and run claims. */
class SqliteSessionStorage implements SessionStorage {
  private readonly db: DatabaseSync;
  private readonly metadata: SessionMetadata;
  private closed = false;
  private readonly changes: SqliteChangeTracker;
  private readonly closeController = new AbortController();
  private readonly onClose: () => void;
  private readonly claimOptions: RunClaimOptions;
  private readonly writers = new Set<SqliteRunWriter>();

  constructor(
    db: DatabaseSync,
    metadata: SessionMetadata,
    claimOptions: RunClaimOptions,
    changes: SqliteChangeTracker,
    onClose: () => void,
  ) {
    this.db = db;
    this.metadata = metadata;
    this.claimOptions = claimOptions;
    this.changes = changes;
    this.onClose = onClose;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionError("storage", `Session is closed: ${this.metadata.id}`);
    }
  }

  private readLeafId(head: string): string | null {
    return readLeafId(this.db, this.metadata.id, head);
  }

  private entryExists(id: string): boolean {
    return entryExists(this.db, this.metadata.id, id);
  }

  getMetadata(): Promise<SessionMetadata> {
    this.assertOpen();
    return Promise.resolve(this.metadata);
  }

  getEntry(id: string): Promise<Entry | undefined> {
    this.assertOpen();
    const row = sql`SELECT payload FROM entries
      WHERE session_id = ${this.metadata.id} AND id = ${id}`.get<{ payload: string }>(this.db);
    return Promise.resolve(row === undefined ? undefined : readPayload<Entry>(row));
  }

  getLeafId(head: string): Promise<string | null> {
    this.assertOpen();
    return Promise.resolve(this.readLeafId(head));
  }

  getBranch(head: string): Promise<Entry[]> {
    this.assertOpen();
    const leafId = this.readLeafId(head);
    if (leafId === null) return Promise.resolve([]);
    const rows = sql`WITH RECURSIVE chain(id) AS (
        VALUES(${leafId})
        UNION ALL
        SELECT e.parent_id FROM entries e JOIN chain c ON e.id = c.id
        WHERE e.session_id = ${this.metadata.id} AND e.parent_id IS NOT NULL
      )
      SELECT payload FROM entries
      WHERE session_id = ${this.metadata.id} AND id IN (SELECT id FROM chain)
      ORDER BY seq`.all<{ payload: string }>(this.db);
    return Promise.resolve(rows.map((row) => readPayload<Entry>(row)));
  }

  findEntries(query?: EntryQuery): Promise<Entry[]> {
    this.assertOpen();
    const predicates = [sql`session_id = ${this.metadata.id}`];
    if (query?.type !== undefined) predicates.push(sql`type = ${query.type}`);
    const limit = query?.limit === undefined ? sql`` : sql` LIMIT ${query.limit}`;
    const rows = sql`SELECT payload FROM entries
      WHERE ${joinSqlFragments(predicates, " AND ")}
      ORDER BY seq${limit}`.all<{ payload: string }>(this.db);
    return Promise.resolve(rows.map((row) => readPayload<Entry>(row)));
  }

  findRecords<K extends SessionRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<SessionRecord, { type: K }>[]> {
    this.assertOpen();
    const predicates = [sql`session_id = ${this.metadata.id}`, sql`type = ${query.type}`];
    if (query.runId !== undefined) predicates.push(sql`run_id = ${query.runId}`);
    if (query.afterSeq !== undefined) predicates.push(sql`seq > ${query.afterSeq}`);
    const rows = sql`SELECT payload FROM records
      WHERE ${joinSqlFragments(predicates, " AND ")}
      ORDER BY seq`.all<RecordRow>(this.db);
    return Promise.resolve(
      rows.map((row) => readPayload<Extract<SessionRecord, { type: K }>>(row)),
    );
  }

  findOpenOperations(head: string): Promise<OperationStartedRecord[]> {
    this.assertOpen();
    const rows = sql`SELECT payload FROM records
      WHERE session_id = ${this.metadata.id} AND head = ${head} AND type = ${OPERATION_STARTED}
        AND id NOT IN (
          SELECT run_id FROM records
          WHERE session_id = ${this.metadata.id} AND type = ${OPERATION_FINISHED}
            AND run_id IS NOT NULL
        )
      ORDER BY seq DESC`.all<RecordRow>(this.db);
    return Promise.resolve(rows.map((row) => readPayload<OperationStartedRecord>(row)));
  }

  async runState(runId: string): Promise<RunState> {
    this.assertOpen();
    return projectRunState(await this.getLog(), runId);
  }

  getLog(options?: { afterSeq?: number }): Promise<LogItem[]> {
    this.assertOpen();
    const after = options?.afterSeq ?? -1;
    const entryRows = sql`SELECT seq, head, payload FROM entries
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<EntryRow>(this.db);
    const recordRows = sql`SELECT seq, payload FROM records
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<RecordRow>(this.db);
    const headRows = sql`SELECT seq, head, leaf_id FROM head_moves
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<{
      seq: number;
      head: string;
      leaf_id: string | null;
    }>(this.db);
    const factRows = sql`SELECT seq, value FROM facts
      WHERE session_id = ${this.metadata.id} AND fact = ${FACT_NAME} AND seq > ${after}`.all<{
      seq: number;
      value: string;
    }>(this.db);
    const factValueRows = sql`SELECT seq, fact, value FROM facts
      WHERE session_id = ${this.metadata.id} AND fact <> ${FACT_NAME} AND seq > ${after}`.all<{
      seq: number;
      fact: string;
      value: string;
    }>(this.db);
    const claimRows = sql`SELECT seq, head, run_id, owner_id, fence, expires_at_ms, action
      FROM run_claim_events
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<ClaimEventRow>(this.db);
    const log: LogItem[] = [
      ...entryRows.map((row): LogItem => ({
        kind: "entry",
        seq: row.seq,
        head: row.head,
        entry: readPayload<Entry>(row),
      })),
      ...recordRows.map((row): LogItem => ({
        kind: "record",
        seq: row.seq,
        record: readPayload<SessionRecord>(row),
      })),
      ...headRows.map((row): LogItem => ({
        kind: "head",
        seq: row.seq,
        head: row.head,
        leafId: row.leaf_id,
      })),
      ...factRows.map((row): LogItem => ({
        kind: "fact",
        seq: row.seq,
        fact: FACT_NAME,
        name: row.value,
      })),
      ...factValueRows.map((row): LogItem => ({
        kind: "fact_value",
        seq: row.seq,
        fact: row.fact,
        value: decodeFact(row.value),
      })),
      ...claimRows.map(claimLogItem),
    ];
    return Promise.resolve(log.sort((a, b) => a.seq - b.seq));
  }

  getName(): Promise<string | undefined> {
    this.assertOpen();
    const row = sql`SELECT value FROM facts
      WHERE session_id = ${this.metadata.id} AND fact = ${FACT_NAME}
      ORDER BY seq DESC LIMIT 1`.get<{ value: string }>(this.db);
    return Promise.resolve(row?.value);
  }

  getFact(fact: string): Promise<JsonValue | undefined> {
    this.assertOpen();
    const row = sql`SELECT value FROM facts
      WHERE session_id = ${this.metadata.id} AND fact = ${fact}
      ORDER BY seq DESC LIMIT 1`.get<{ value: string }>(this.db);
    return Promise.resolve(row === undefined ? undefined : decodeFact(row.value));
  }

  listFacts(prefix: string): Promise<{ fact: string; value: JsonValue }[]> {
    this.assertOpen();
    const rows = sql`SELECT fact, value FROM facts
      WHERE session_id = ${this.metadata.id} AND fact >= ${prefix} AND fact < ${prefix + "\uffff"}
      AND seq = (SELECT MAX(seq) FROM facts f2 WHERE f2.session_id = facts.session_id AND f2.fact = facts.fact)
      ORDER BY fact`.all<{ fact: string; value: string }>(this.db);
    const out: { fact: string; value: JsonValue }[] = [];
    for (const row of rows) {
      if (row.fact === FACT_NAME) continue;
      const value = decodeFact(row.value);
      if (value !== undefined) out.push({ fact: row.fact, value });
    }
    return Promise.resolve(out);
  }

  watch(options: WatchOptions = {}): AsyncIterable<LogItem> {
    this.assertOpen();
    const session = this;
    const signals =
      options.signal === undefined
        ? [this.closeController.signal]
        : [this.closeController.signal, options.signal];
    async function* events(): AsyncIterable<LogItem> {
      const subscription = session.changes.subscribe(session.metadata.id, signals);
      let cursor = options.afterSeq ?? -1;
      try {
        while (!subscription.closed) {
          const items = await session.getLog({ afterSeq: cursor });
          for (const item of items) {
            if (subscription.closed) return;
            cursor = item.seq;
            yield item;
          }
          await subscription.wait();
        }
      } finally {
        subscription.close();
      }
    }
    return events();
  }

  async appendEntry(entry: ProvisionedEntry, head: string): Promise<Entry> {
    return this.write(() => {
      this.assertHeadIdle(head);
      return writeEntry(this.db, this.metadata.id, entry, head);
    });
  }

  async appendEntries(entries: readonly ProvisionedEntry[], head: string): Promise<Entry[]> {
    return this.write(() => {
      this.assertHeadIdle(head);
      return entries.map((entry) => writeEntry(this.db, this.metadata.id, entry, head));
    });
  }

  async appendRecord<TRecord extends ParticipantRecord>(
    record: NewRecord<TRecord>,
  ): Promise<TRecord> {
    assertParticipantRecord(record);
    return this.write(() => writeRecord(this.db, this.metadata.id, record));
  }

  async moveHead(head: string, to: string | null): Promise<void> {
    this.write(() => {
      this.assertHeadIdle(head);
      moveHead(this.db, this.metadata.id, head, to);
    });
  }

  async setName(name: string): Promise<void> {
    this.write(() => {
      sql`INSERT INTO facts (session_id, seq, fact, value)
        VALUES (${this.metadata.id}, ${allocateSeq(this.db, this.metadata.id, 1)},
                ${FACT_NAME}, ${name})`.run(this.db);
    });
  }

  async setFact(fact: string, value: JsonValue | undefined): Promise<void> {
    if (fact === FACT_NAME) {
      throw new SessionError("invalid_entry", `${FACT_NAME} is set through setName`);
    }
    this.write(() => {
      sql`INSERT INTO facts (session_id, seq, fact, value)
        VALUES (${this.metadata.id}, ${allocateSeq(this.db, this.metadata.id, 1)},
                ${fact}, ${encodeFact(value)})`.run(this.db);
    });
  }

  async send(
    input: string | MessageEntry["message"],
    options: SendOptions = {},
  ): Promise<SendReceipt> {
    const head = options.head ?? "main";
    const origin = normalizeOrigin(options.origin);
    return this.write(() => {
      if (options.idempotencyKey !== undefined) {
        const existing = sql`SELECT receipt FROM send_keys
            WHERE session_id = ${this.metadata.id} AND key = ${options.idempotencyKey}`.get<{
          receipt: string;
        }>(this.db);
        if (existing !== undefined) return parseSendReceipt(existing.receipt);
      }

      const message: MessageEntry["message"] =
        typeof input === "string" ? { role: "user", content: input, timestamp: Date.now() } : input;
      const target: ProvisionedEntry<MessageEntry> = {
        type: "message",
        id: newId("e"),
        message,
        ...(origin === undefined ? {} : { origin }),
      };
      const claim = readLiveClaim(this.db, this.metadata.id, head);
      let receipt: SendReceipt;
      if (claim === undefined) {
        const entry = writeEntry(this.db, this.metadata.id, target, head);
        receipt = { disposition: "placed", entryId: entry.id, duplicate: false };
      } else {
        writeRecord(this.db, this.metadata.id, {
          type: "queue_enqueued",
          id: newId("r"),
          head: head,
          queue: options.delivery === "queue" ? "followUp" : "steer",
          runId: claim.runId,
          target,
        });
        receipt = {
          disposition: "queued",
          entryId: target.id,
          runId: claim.runId,
          duplicate: false,
        };
      }
      if (options.idempotencyKey !== undefined) {
        const encoded = JSON.stringify(toJsonValue(receipt));
        sql`INSERT INTO send_keys (session_id, key, receipt)
            VALUES (${this.metadata.id}, ${options.idempotencyKey}, ${encoded})`.run(this.db);
      }
      return receipt;
    });
  }

  async admitEntry(entry: ProvisionedEntry, head = "main"): Promise<EntryAdmission> {
    return this.write(() => {
      if (entryExists(this.db, this.metadata.id, entry.id)) {
        throw new SessionError("invalid_entry", `Entry id already exists: ${entry.id}`);
      }
      const claim = readLiveClaim(this.db, this.metadata.id, head);
      if (claim === undefined) {
        writeEntry(this.db, this.metadata.id, entry, head);
        return { disposition: "placed" };
      }
      writeRecord(this.db, this.metadata.id, {
        type: "deferred_write",
        id: newId("r"),
        head: head,
        runId: claim.runId,
        target: entry,
      });
      return { disposition: "deferred", runId: claim.runId };
    });
  }

  async requestAbort(head = "main"): Promise<{ runId: string } | undefined> {
    return this.write(() => {
      const claim = readLiveClaim(this.db, this.metadata.id, head);
      if (claim === undefined) return undefined;
      writeRecord(this.db, this.metadata.id, {
        type: "abort_requested",
        id: newId("r"),
        head: head,
        runId: claim.runId,
      });
      return { runId: claim.runId };
    });
  }

  async getLiveClaim(head: string): Promise<RunClaim | undefined> {
    this.assertOpen();
    return readLiveClaim(this.db, this.metadata.id, head);
  }

  async claimRun(head: string, runId: string): Promise<ClaimRunOutcome> {
    this.assertOpen();
    const outcome = transact(this.db, () => {
      const acquired = acquireRunClaim(
        this.db,
        this.metadata.id,
        head,
        runId,
        this.claimOptions.ttlMs,
      );
      if (acquired.ok) {
        writeClaimEvent(this.db, this.metadata.id, { kind: "acquired", claim: acquired.claim });
      }
      return acquired;
    });
    if (!outcome.ok) return outcome;
    this.changes.notify(this.metadata.id);

    let writer: SqliteRunWriter;
    writer = new SqliteRunWriter(
      this.db,
      this.metadata.id,
      outcome.claim,
      this.claimOptions,
      this.changes,
      () => this.writers.delete(writer),
    );
    this.writers.add(writer);
    return { ok: true, claim: outcome.claim, writer };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const errors: unknown[] = [];
    for (const writer of [...this.writers]) {
      await writer.release().catch((error: unknown) => errors.push(error));
    }
    this.closed = true;
    this.closeController.abort();
    this.onClose();
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close run writers");
  }

  private write<T>(fn: () => T): T {
    this.assertOpen();
    const result = transact(this.db, fn);
    this.changes.notify(this.metadata.id);
    return result;
  }

  private assertHeadIdle(head: string): void {
    if (readLiveClaim(this.db, this.metadata.id, head) !== undefined) {
      throw new SessionError(
        "invalid_entry",
        `Head ${head} has a live run; admit messages through send()`,
      );
    }
  }
}

class SqliteRunWriter implements RunWriter {
  readonly claim: RunClaim;
  private readonly claimLostController = new AbortController();
  readonly claimLost = this.claimLostController.signal;
  private readonly db: DatabaseSync;
  private readonly sessionId: string;
  private readonly options: RunClaimOptions;
  private readonly changes: SqliteChangeTracker;
  private readonly onRelease: () => void;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private claimError: SessionError | undefined;
  private detached = false;
  private released = false;

  constructor(
    db: DatabaseSync,
    sessionId: string,
    claim: RunClaim,
    options: RunClaimOptions,
    changes: SqliteChangeTracker,
    onRelease: () => void,
  ) {
    this.db = db;
    this.sessionId = sessionId;
    this.claim = claim;
    this.options = options;
    this.changes = changes;
    this.onRelease = onRelease;
    this.scheduleHeartbeat();
  }

  async appendEntry(entry: ProvisionedEntry): Promise<Entry> {
    return this.write(() => writeEntry(this.db, this.sessionId, entry, this.claim.head));
  }

  async appendEntries(entries: readonly ProvisionedEntry[]): Promise<Entry[]> {
    return this.write(() =>
      entries.map((entry) => writeEntry(this.db, this.sessionId, entry, this.claim.head)),
    );
  }

  async applyDeferred(): Promise<Entry[]> {
    return this.write(() => applyDeferredWrites(this.db, this.sessionId, this.claim.head));
  }

  async appendRecord<TRecord extends RunRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
    assertRunRecord(record);
    this.assertRunRecord(record);
    return this.write(() => writeRecord(this.db, this.sessionId, record));
  }

  async moveHead(to: string | null): Promise<void> {
    this.write(() => moveHead(this.db, this.sessionId, this.claim.head, to));
  }

  async renew(): Promise<boolean> {
    this.assertActive();
    const renewed = transact(this.db, () =>
      renewClaim(this.db, this.sessionId, this.claim, Date.now() + this.options.ttlMs),
    );
    if (!renewed) this.loseClaim();
    else this.changes.notify(this.sessionId);
    return renewed;
  }

  async finish(record: NewRecord<OperationFinishedRecord>): Promise<{
    record: OperationFinishedRecord;
    deferredEntries: Entry[];
  }> {
    assertRunRecord(record);
    this.assertRunRecord(record);
    this.assertActive();
    const result = transact(this.db, () => {
      // Silent fencing renewal: finalization produces only its own durable items.
      if (!renewRunClaim(this.db, this.sessionId, this.claim, Date.now() + this.options.ttlMs)) {
        throw this.loseClaim();
      }
      const deferredEntries = applyDeferredWrites(this.db, this.sessionId, this.claim.head);
      const finished = writeRecord(this.db, this.sessionId, record);
      releaseClaim(this.db, this.sessionId, this.claim);
      return { record: finished, deferredEntries };
    });
    this.released = true;
    this.stopHeartbeat();
    this.detach();
    this.changes.notify(this.sessionId);
    return result;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopHeartbeat();
    if (this.claimError !== undefined) {
      this.detach();
      return;
    }
    try {
      transact(this.db, () => releaseClaim(this.db, this.sessionId, this.claim));
      this.changes.notify(this.sessionId);
    } finally {
      this.detach();
    }
  }

  private write<T>(fn: () => T): T {
    this.assertActive();
    const result = transact(this.db, () => {
      // Silent fencing renewal: no `renewed` log event per write (see renewClaim).
      if (!renewRunClaim(this.db, this.sessionId, this.claim, Date.now() + this.options.ttlMs)) {
        throw this.loseClaim();
      }
      return fn();
    });
    this.changes.notify(this.sessionId);
    return result;
  }

  private assertRunRecord(record: NewRecord<RunRecord>): void {
    if (record.head !== this.claim.head) {
      throw new SessionError(
        "invalid_entry",
        `Run ${this.claim.runId} cannot write to head ${record.head}`,
      );
    }
    const runId = runIdOf(record);
    if (runId !== null && runId !== this.claim.runId) {
      throw new SessionError(
        "invalid_entry",
        `Run writer ${this.claim.runId} cannot write record for ${runId}`,
      );
    }
  }

  private assertActive(): void {
    if (this.released) {
      throw new SessionError("storage", `Run writer is released: ${this.claim.runId}`);
    }
    if (this.claimError !== undefined) throw this.claimError;
  }

  private loseClaim(): SessionError {
    this.claimError ??= new SessionError(
      "claim_lost",
      `Run claim lost for ${this.claim.runId} on head ${this.claim.head}`,
    );
    this.stopHeartbeat();
    this.claimLostController.abort(this.claimError);
    this.detach();
    return this.claimError;
  }

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.onRelease();
  }

  private scheduleHeartbeat(): void {
    if (this.released || this.claimError !== undefined) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      void this.renew()
        .catch(() => undefined)
        .finally(() => this.scheduleHeartbeat());
    }, this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

export interface SqliteSessionRepoOptions {
  claimTtlMs?: number;
  /** Hot-run heartbeat cadence. Default: 10 seconds. Must be less than claimTtlMs. */
  claimHeartbeatIntervalMs?: number;
  /** Cross-process watch wake cadence. Polling runs only while a watcher exists. */
  watchPollIntervalMs?: number;
}

export class SqliteSessionRepo implements SessionRepo, SessionSearch {
  private readonly path: string;
  private readonly claimOptions: RunClaimOptions;
  private readonly watchPollIntervalMs: number;
  private db: DatabaseSync | undefined;
  private changes: SqliteChangeTracker | undefined;
  private readonly active = new Set<SqliteSessionStorage>();

  constructor(path: string, options?: SqliteSessionRepoOptions) {
    this.path = path;
    this.claimOptions = resolveRunClaimOptions(options);
    this.watchPollIntervalMs = resolveWatchPollIntervalMs(options);
  }

  private database(): DatabaseSync {
    if (this.db === undefined) {
      mkdirSync(dirname(this.path), { recursive: true });
      const db = new DatabaseSync(this.path);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=FULL");
      db.exec("PRAGMA busy_timeout=5000");
      db.exec(SCHEMA);
      this.db = db;
      this.changes = new SqliteChangeTracker(db, this.watchPollIntervalMs);
    }
    return this.db;
  }

  private storage(db: DatabaseSync, metadata: SessionMetadata): SqliteSessionStorage {
    const changes = this.changes;
    if (changes === undefined) throw new SessionError("storage", "Session repository is closed");
    let storage: SqliteSessionStorage;
    storage = new SqliteSessionStorage(db, metadata, this.claimOptions, changes, () =>
      this.active.delete(storage),
    );
    this.active.add(storage);
    return storage;
  }

  async create(options?: { id?: string }): Promise<SessionStorage> {
    const db = this.database();
    const id = options?.id ?? `${new Date().toISOString().replaceAll(":", "-")}-${newId("s")}`;
    const metadata: SessionMetadata = { id, createdAt: Date.now() };
    transact(db, () => {
      const inserted = sql`INSERT OR IGNORE INTO sessions (id, created_at, next_seq)
        VALUES (${id}, ${metadata.createdAt}, 1)`.run(db);
      if (Number(inserted.changes) !== 1) {
        throw new SessionError("storage", `Session already exists: ${id}`);
      }
      sql`INSERT INTO heads (session_id, head, leaf_id) VALUES (${id}, ${"main"}, ${null})`.run(db);
    });
    return this.storage(db, metadata);
  }

  async open(id: string): Promise<SessionStorage> {
    const db = this.database();
    const row = sql`SELECT id, created_at FROM sessions WHERE id = ${id}`.get<{
      id: string;
      created_at: number;
    }>(db);
    if (row === undefined) {
      throw new SessionError("not_found", `Session not found: ${id}`);
    }
    return this.storage(db, { id: row.id, createdAt: row.created_at });
  }

  async list(): Promise<SessionMetadata[]> {
    const rows = sql`SELECT id, created_at FROM sessions ORDER BY created_at, id`.all<{
      id: string;
      created_at: number;
    }>(this.database());
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
  }

  async searchEntries(
    text: string,
    options?: { limit?: number; type?: Entry["type"] },
  ): Promise<SessionSearchHit[]> {
    const query = text.trim();
    if (query.length < 3) return []; // The trigram tokenizer needs 3 or more characters.
    // Quoted as one FTS string so user text cannot be parsed as query syntax.
    const predicates = [sql`entries_fts MATCH ${`"${query.replaceAll('"', '""')}"`}`];
    if (options?.type !== undefined) predicates.push(sql`e.type = ${options.type}`);
    const rows = sql`SELECT e.session_id, e.id, e.timestamp,
        snippet(entries_fts, 0, '', '', '…', 12) AS snippet,
        bm25(entries_fts) AS score
      FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
      WHERE ${joinSqlFragments(predicates, " AND ")}
      ORDER BY score LIMIT ${options?.limit ?? 20}`.all<{
      session_id: string;
      id: string;
      timestamp: number;
      snippet: string;
      score: number;
    }>(this.database());
    return rows.map((row) => ({
      sessionId: row.session_id,
      entryId: row.id,
      timestamp: row.timestamp,
      snippet: row.snippet,
      score: row.score,
    }));
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const storage of [...this.active]) {
      await storage.close().catch((error: unknown) => errors.push(error));
    }
    this.active.clear();
    this.changes?.close();
    this.changes = undefined;
    if (this.db !== undefined) {
      try {
        this.db.close();
      } catch (error) {
        errors.push(error);
      }
      this.db = undefined;
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close session repository");
  }
}
