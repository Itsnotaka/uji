import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { joinSqlFragments, sql } from "./sql.ts";
import {
  newId,
  SessionError,
  type Entry,
  type EntryQuery,
  type LaneRecord,
  type LogItem,
  type NewRecord,
  type OperationFinishedRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionMetadata,
  type SessionRepo,
  type SessionSearch,
  type SessionSearchHit,
  type SessionStorage,
} from "./types.ts";

/**
 * SQLite session backend, after pi's sqlite-node backend and the storage model
 * in harness.md Part 1: entries and records are write-once rows, lane pointers
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
 * - The writer lease is expiring, fenced ownership. WAL happily interleaves
 *   writers from several processes, which is exactly what the model forbids;
 *   the lease makes one-writer-per-session an enforced property. Renewal and
 *   release are keyed on (owner, fence) so a stale owner can neither write past
 *   nor release the successor that replaced it. Writes renew transactionally
 *   and a heartbeat renews while idle, so an expired lease genuinely means the
 *   owner is gone.
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

const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

interface WriterLeaseOptions {
  ttlMs: number;
  heartbeatIntervalMs: number;
}

function resolveWriterLeaseOptions(options?: SqliteSessionRepoOptions): WriterLeaseOptions {
  const ttlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("leaseTtlMs must be positive");
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    heartbeatIntervalMs >= ttlMs
  ) {
    throw new RangeError("heartbeatIntervalMs must be positive and less than leaseTtlMs");
  }
  return { ttlMs, heartbeatIntervalMs };
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
  lane TEXT NOT NULL,
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
  lane TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_records_lane_type_seq ON records(session_id, lane, type, seq);
CREATE INDEX IF NOT EXISTS idx_records_run_seq ON records(session_id, run_id, seq);

CREATE TABLE IF NOT EXISTS lanes (
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  leaf_id TEXT,
  PRIMARY KEY (session_id, lane)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lane_moves (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  lane TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS writer_leases (
  session_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

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

interface WriterLease {
  ownerId: string;
  fence: number;
}

/**
 * Claims the session for one writer. The upsert succeeds only when no lease
 * exists or the existing one has expired; a takeover increments the fence,
 * which invalidates every write the previous owner might still attempt.
 */
function acquireWriterLease(db: DatabaseSync, sessionId: string, ttlMs: number): WriterLease {
  const now = Date.now();
  const row = sql`INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms)
    VALUES (${sessionId}, ${newId("w")}, 1, ${now + ttlMs})
    ON CONFLICT(session_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      fence = writer_leases.fence + 1,
      expires_at_ms = excluded.expires_at_ms
    WHERE writer_leases.expires_at_ms <= ${now}
    RETURNING owner_id, fence`.get<{ owner_id: string; fence: number }>(db);
  if (row === undefined) {
    throw new SessionError("storage", `Session already has an active writer: ${sessionId}`);
  }
  return { ownerId: row.owner_id, fence: row.fence };
}

/**
 * Extends the lease iff this owner still holds it and it has not yet expired.
 * An expired lease is never resurrected — the heartbeat keeps a live session's
 * lease fresh, so expiry is real evidence the owner is gone.
 */
function renewWriterLease(
  db: DatabaseSync,
  sessionId: string,
  lease: WriterLease,
  now: number,
  expiresAtMs: number,
): boolean {
  const result = sql`UPDATE writer_leases SET expires_at_ms = ${expiresAtMs}
    WHERE session_id = ${sessionId}
      AND owner_id = ${lease.ownerId}
      AND fence = ${lease.fence}
      AND expires_at_ms > ${now}`.run(db);
  return Number(result.changes) === 1;
}

function releaseWriterLease(db: DatabaseSync, sessionId: string, lease: WriterLease): void {
  sql`DELETE FROM writer_leases
    WHERE session_id = ${sessionId}
      AND owner_id = ${lease.ownerId}
      AND fence = ${lease.fence}`.run(db);
}

interface EntryRow {
  seq: number;
  lane: string;
  payload: string;
}

interface RecordRow {
  seq: number;
  payload: string;
}

export class SqliteSessionStorage implements SessionStorage {
  private readonly db: DatabaseSync;
  private readonly metadata: SessionMetadata;
  private readonly lease: WriterLease;
  private readonly leaseOptions: WriterLeaseOptions;
  private readonly onClose: (storage: SqliteSessionStorage) => void;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseError: SessionError | undefined;
  private closed = false;

  constructor(
    db: DatabaseSync,
    metadata: SessionMetadata,
    lease: WriterLease,
    leaseOptions: WriterLeaseOptions,
    onClose: (storage: SqliteSessionStorage) => void,
  ) {
    this.db = db;
    this.metadata = metadata;
    this.lease = lease;
    this.leaseOptions = leaseOptions;
    this.onClose = onClose;
    this.scheduleHeartbeat();
  }

  private lostLease(): SessionError {
    this.leaseError = new SessionError(
      "storage",
      `Writer lease lost for session ${this.metadata.id}`,
    );
    if (this.heartbeatTimer !== undefined) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    return this.leaseError;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionError("storage", `Session is closed: ${this.metadata.id}`);
    }
  }

  /**
   * Renews the lease while the session is open but not writing, so it never
   * expires under a live owner. Unref'd so an open session does not keep the
   * process alive.
   */
  private scheduleHeartbeat(): void {
    if (this.closed || this.leaseError !== undefined) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      try {
        const now = Date.now();
        if (
          !renewWriterLease(
            this.db,
            this.metadata.id,
            this.lease,
            now,
            now + this.leaseOptions.ttlMs,
          )
        ) {
          this.lostLease();
        }
      } catch {
        // A transient heartbeat failure is retried; every write still verifies
        // ownership transactionally.
      } finally {
        this.scheduleHeartbeat();
      }
    }, this.leaseOptions.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  /**
   * Runs one writing transaction. Renewing the lease inside it is the fencing
   * check: if another process took the session over, the renewal matches zero
   * rows and the write dies before touching data. A lost lease is terminal
   * for this instance; reopen through the repo.
   */
  private write<T>(fn: () => T): T {
    this.assertOpen();
    if (this.leaseError !== undefined) throw this.leaseError;
    return transact(this.db, () => {
      const now = Date.now();
      if (
        !renewWriterLease(this.db, this.metadata.id, this.lease, now, now + this.leaseOptions.ttlMs)
      ) {
        throw this.lostLease();
      }
      return fn();
    });
  }

  /**
   * One counter orders entries, records, lane moves, and facts alike; getLog
   * merges the four tables on it and every afterSeq cursor depends on it
   * (see SessionStorage in types.ts).
   */
  private allocateSeq(count: number): number {
    const row = sql`SELECT next_seq FROM sessions WHERE id = ${this.metadata.id}`.get<{
      next_seq: number;
    }>(this.db);
    if (row === undefined) {
      throw new SessionError("not_found", `Session not found: ${this.metadata.id}`);
    }
    sql`UPDATE sessions SET next_seq = ${row.next_seq + count} WHERE id = ${this.metadata.id}`.run(
      this.db,
    );
    return row.next_seq;
  }

  private readLeafId(lane: string): string | null {
    const row = sql`SELECT leaf_id FROM lanes
      WHERE session_id = ${this.metadata.id} AND lane = ${lane}`.get<{ leaf_id: string | null }>(
      this.db,
    );
    return row?.leaf_id ?? null;
  }

  private entryExists(id: string): boolean {
    return (
      sql`SELECT 1 FROM entries WHERE session_id = ${this.metadata.id} AND id = ${id}`.get(
        this.db,
      ) !== undefined
    );
  }

  /** Appends to the move log and updates the lane's current leaf together. */
  private writeLaneMove(seq: number, lane: string, leafId: string | null): void {
    sql`INSERT INTO lane_moves (session_id, seq, lane, leaf_id)
      VALUES (${this.metadata.id}, ${seq}, ${lane}, ${leafId})`.run(this.db);
    sql`INSERT INTO lanes (session_id, lane, leaf_id) VALUES (${this.metadata.id}, ${lane}, ${leafId})
      ON CONFLICT(session_id, lane) DO UPDATE SET leaf_id = excluded.leaf_id`.run(this.db);
  }

  getMetadata(): Promise<SessionMetadata> {
    this.assertOpen();
    return Promise.resolve(this.metadata);
  }

  appendEntry(entry: ProvisionedEntry, lane: string): Promise<Entry> {
    return Promise.resolve(
      this.write(() => {
        if (this.entryExists(entry.id)) {
          throw new SessionError("invalid_entry", `Entry id already exists: ${entry.id}`);
        }
        // The entry and the lane move it implies each take a seq of their own,
        // so getLog interleaves them in commit order.
        const seq = this.allocateSeq(2);
        const full = {
          ...entry,
          parentId: this.readLeafId(lane),
          seq,
          timestamp: Date.now(),
        } as Entry;
        sql`INSERT INTO entries (session_id, seq, id, parent_id, lane, type, timestamp, payload)
          VALUES (${this.metadata.id}, ${seq}, ${full.id}, ${full.parentId}, ${lane}, ${full.type},
                  ${full.timestamp}, ${JSON.stringify(full)})`.run(this.db);
        this.writeLaneMove(seq + 1, lane, full.id);
        return full;
      }),
    );
  }

  appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
    return Promise.resolve(
      this.write(() => {
        const seq = this.allocateSeq(1);
        const full = { ...record, seq, timestamp: Date.now() } as unknown as TRecord;
        const runId =
          record.type === OPERATION_STARTED
            ? record.id
            : "runId" in record
              ? (record as { runId: string }).runId
              : null;
        sql`INSERT INTO records (session_id, seq, id, lane, type, run_id, timestamp, payload)
          VALUES (${this.metadata.id}, ${seq}, ${record.id}, ${record.lane}, ${record.type},
                  ${runId}, ${full.timestamp}, ${JSON.stringify(full)})`.run(this.db);
        return full;
      }),
    );
  }

  getEntry(id: string): Promise<Entry | undefined> {
    this.assertOpen();
    const row = sql`SELECT payload FROM entries
      WHERE session_id = ${this.metadata.id} AND id = ${id}`.get<{ payload: string }>(this.db);
    return Promise.resolve(row === undefined ? undefined : (JSON.parse(row.payload) as Entry));
  }

  getLeafId(lane: string): Promise<string | null> {
    this.assertOpen();
    return Promise.resolve(this.readLeafId(lane));
  }

  moveLane(lane: string, to: string | null): Promise<void> {
    this.write(() => {
      if (to !== null && !this.entryExists(to)) {
        throw new SessionError("not_found", `Entry not found: ${to}`);
      }
      this.writeLaneMove(this.allocateSeq(1), lane, to);
    });
    return Promise.resolve();
  }

  getBranch(lane: string): Promise<Entry[]> {
    this.assertOpen();
    const leafId = this.readLeafId(lane);
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
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as Entry));
  }

  findEntries(query?: EntryQuery): Promise<Entry[]> {
    this.assertOpen();
    const predicates = [sql`session_id = ${this.metadata.id}`];
    if (query?.type !== undefined) predicates.push(sql`type = ${query.type}`);
    const limit = query?.limit === undefined ? sql`` : sql` LIMIT ${query.limit}`;
    const rows = sql`SELECT payload FROM entries
      WHERE ${joinSqlFragments(predicates, " AND ")}
      ORDER BY seq${limit}`.all<{ payload: string }>(this.db);
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as Entry));
  }

  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]> {
    this.assertOpen();
    const predicates = [sql`session_id = ${this.metadata.id}`, sql`type = ${query.type}`];
    if (query.runId !== undefined) predicates.push(sql`run_id = ${query.runId}`);
    if (query.afterSeq !== undefined) predicates.push(sql`seq > ${query.afterSeq}`);
    const rows = sql`SELECT payload FROM records
      WHERE ${joinSqlFragments(predicates, " AND ")}
      ORDER BY seq`.all<RecordRow>(this.db);
    return Promise.resolve(
      rows.map((row) => JSON.parse(row.payload) as Extract<LaneRecord, { type: K }>),
    );
  }

  findOpenOperations(lane: string): Promise<OperationStartedRecord[]> {
    this.assertOpen();
    const rows = sql`SELECT payload FROM records
      WHERE session_id = ${this.metadata.id} AND lane = ${lane} AND type = ${OPERATION_STARTED}
        AND id NOT IN (
          SELECT run_id FROM records
          WHERE session_id = ${this.metadata.id} AND type = ${OPERATION_FINISHED}
            AND run_id IS NOT NULL
        )
      ORDER BY seq DESC`.all<RecordRow>(this.db);
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as OperationStartedRecord));
  }

  getLog(options?: { afterSeq?: number }): Promise<LogItem[]> {
    this.assertOpen();
    const after = options?.afterSeq ?? -1;
    const entryRows = sql`SELECT seq, lane, payload FROM entries
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<EntryRow>(this.db);
    const recordRows = sql`SELECT seq, payload FROM records
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<RecordRow>(this.db);
    const laneRows = sql`SELECT seq, lane, leaf_id FROM lane_moves
      WHERE session_id = ${this.metadata.id} AND seq > ${after}`.all<{
      seq: number;
      lane: string;
      leaf_id: string | null;
    }>(this.db);
    const factRows = sql`SELECT seq, value FROM facts
      WHERE session_id = ${this.metadata.id} AND fact = ${FACT_NAME} AND seq > ${after}`.all<{
      seq: number;
      value: string;
    }>(this.db);
    const log: LogItem[] = [
      ...entryRows.map((row): LogItem => ({
        kind: "entry",
        seq: row.seq,
        lane: row.lane,
        entry: JSON.parse(row.payload) as Entry,
      })),
      ...recordRows.map((row): LogItem => ({
        kind: "record",
        seq: row.seq,
        record: JSON.parse(row.payload) as LaneRecord,
      })),
      ...laneRows.map((row): LogItem => ({
        kind: "lane",
        seq: row.seq,
        lane: row.lane,
        leafId: row.leaf_id,
      })),
      ...factRows.map((row): LogItem => ({
        kind: "fact",
        seq: row.seq,
        fact: FACT_NAME,
        name: row.value,
      })),
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

  setName(name: string): Promise<void> {
    this.write(() => {
      sql`INSERT INTO facts (session_id, seq, fact, value)
        VALUES (${this.metadata.id}, ${this.allocateSeq(1)}, ${FACT_NAME}, ${name})`.run(this.db);
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (this.heartbeatTimer !== undefined) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
      try {
        releaseWriterLease(this.db, this.metadata.id, this.lease);
      } finally {
        this.onClose(this);
      }
    }
    return Promise.resolve();
  }
}

export interface SqliteSessionRepoOptions {
  leaseTtlMs?: number;
  /** Idle heartbeat cadence. Default: 10 seconds. Must be less than leaseTtlMs. */
  heartbeatIntervalMs?: number;
}

export class SqliteSessionRepo implements SessionRepo, SessionSearch {
  private readonly path: string;
  private readonly leaseOptions: WriterLeaseOptions;
  private db: DatabaseSync | undefined;
  private readonly active = new Set<SqliteSessionStorage>();

  constructor(path: string, options?: SqliteSessionRepoOptions) {
    this.path = path;
    this.leaseOptions = resolveWriterLeaseOptions(options);
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
    }
    return this.db;
  }

  private claim(db: DatabaseSync, metadata: SessionMetadata): SqliteSessionStorage {
    const storage = new SqliteSessionStorage(
      db,
      metadata,
      acquireWriterLease(db, metadata.id, this.leaseOptions.ttlMs),
      this.leaseOptions,
      (closed) => this.active.delete(closed),
    );
    this.active.add(storage);
    return storage;
  }

  async create(options?: { id?: string }): Promise<SessionStorage> {
    const db = this.database();
    const id = options?.id ?? `${new Date().toISOString().replaceAll(":", "-")}-${newId("s")}`;
    const metadata: SessionMetadata = { id, createdAt: Date.now() };
    return transact(db, () => {
      const inserted = sql`INSERT OR IGNORE INTO sessions (id, created_at, next_seq)
        VALUES (${id}, ${metadata.createdAt}, 1)`.run(db);
      if (Number(inserted.changes) !== 1) {
        throw new SessionError("storage", `Session already exists: ${id}`);
      }
      return this.claim(db, metadata);
    });
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
    return this.claim(db, { id: row.id, createdAt: row.created_at });
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
    for (const storage of this.active) await storage.close();
    this.active.clear();
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
  }
}
