import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  newId,
  SessionError,
  type Entry,
  type EntryQuery,
  type LaneRecord,
  type LogItem,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionMetadata,
  type SessionRepo,
  type SessionSearch,
  type SessionSearchHit,
  type SessionStorage,
} from "./types.ts";

type SqliteValue = string | number | null;

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
CREATE TRIGGER IF NOT EXISTS entries_fts_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, payload) VALUES (new.rowid, new.payload);
END;
`;

interface EntryRow {
  seq: number;
  lane: string;
  payload: string;
}

interface RecordRow {
  seq: number;
  payload: string;
}

const DEFAULT_LEASE_TTL_MS = 30_000;

interface WriterLease {
  ownerId: string;
  fence: number;
}

function acquireWriterLease(db: DatabaseSync, sessionId: string, ttlMs: number): WriterLease {
  const now = Date.now();
  const row = db
    .prepare(
      `INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         owner_id = excluded.owner_id,
         fence = writer_leases.fence + 1,
         expires_at_ms = excluded.expires_at_ms
       WHERE writer_leases.expires_at_ms <= ?
       RETURNING owner_id, fence`,
    )
    .get(sessionId, newId("w"), now + ttlMs, now) as
    | { owner_id: string; fence: number }
    | undefined;
  if (row === undefined) {
    throw new SessionError("storage", `Session already has an active writer: ${sessionId}`);
  }
  return { ownerId: row.owner_id, fence: row.fence };
}

export class SqliteSessionStorage implements SessionStorage {
  private readonly db: DatabaseSync;
  private readonly metadata: SessionMetadata;
  private readonly lease: WriterLease;
  private readonly leaseTtlMs: number;
  private closed = false;

  constructor(db: DatabaseSync, metadata: SessionMetadata, lease: WriterLease, leaseTtlMs: number) {
    this.db = db;
    this.metadata = metadata;
    this.lease = lease;
    this.leaseTtlMs = leaseTtlMs;
  }

  private write<T>(fn: () => T): T {
    if (this.closed) {
      throw new SessionError("storage", `Session is closed: ${this.metadata.id}`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const renewed = this.db
        .prepare(
          `UPDATE writer_leases SET expires_at_ms = ?
           WHERE session_id = ? AND owner_id = ? AND fence = ?`,
        )
        .run(Date.now() + this.leaseTtlMs, this.metadata.id, this.lease.ownerId, this.lease.fence);
      if (Number(renewed.changes) !== 1) {
        throw new SessionError("storage", `Writer lease lost for session ${this.metadata.id}`);
      }
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed COMMIT has already rolled back.
      }
      throw error;
    }
  }

  private allocateSeq(count: number): number {
    const row = this.db
      .prepare(`SELECT next_seq FROM sessions WHERE id = ?`)
      .get(this.metadata.id) as { next_seq: number } | undefined;
    if (row === undefined) {
      throw new SessionError("not_found", `Session not found: ${this.metadata.id}`);
    }
    this.db
      .prepare(`UPDATE sessions SET next_seq = ? WHERE id = ?`)
      .run(row.next_seq + count, this.metadata.id);
    return row.next_seq;
  }

  private readLeafId(lane: string): string | null {
    const row = this.db
      .prepare(`SELECT leaf_id FROM lanes WHERE session_id = ? AND lane = ?`)
      .get(this.metadata.id, lane) as { leaf_id: string | null } | undefined;
    return row?.leaf_id ?? null;
  }

  private entryExists(id: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM entries WHERE session_id = ? AND id = ?`)
        .get(this.metadata.id, id) !== undefined
    );
  }

  private writeLaneMove(seq: number, lane: string, leafId: string | null): void {
    this.db
      .prepare(`INSERT INTO lane_moves (session_id, seq, lane, leaf_id) VALUES (?, ?, ?, ?)`)
      .run(this.metadata.id, seq, lane, leafId);
    this.db
      .prepare(
        `INSERT INTO lanes (session_id, lane, leaf_id) VALUES (?, ?, ?)
         ON CONFLICT(session_id, lane) DO UPDATE SET leaf_id = excluded.leaf_id`,
      )
      .run(this.metadata.id, lane, leafId);
  }

  getMetadata(): Promise<SessionMetadata> {
    return Promise.resolve(this.metadata);
  }

  appendEntry(entry: ProvisionedEntry, lane: string): Promise<Entry> {
    return Promise.resolve(
      this.write(() => {
        if (this.entryExists(entry.id)) {
          throw new SessionError("invalid_entry", `Entry id already exists: ${entry.id}`);
        }
        const seq = this.allocateSeq(2);
        const full = {
          ...entry,
          parentId: this.readLeafId(lane),
          seq,
          timestamp: Date.now(),
        } as Entry;
        this.db
          .prepare(
            `INSERT INTO entries (session_id, seq, id, parent_id, lane, type, timestamp, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.metadata.id,
            seq,
            full.id,
            full.parentId,
            lane,
            full.type,
            full.timestamp,
            JSON.stringify(full),
          );
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
          record.type === "operation_started"
            ? record.id
            : "runId" in record
              ? (record as { runId: string }).runId
              : null;
        this.db
          .prepare(
            `INSERT INTO records (session_id, seq, id, lane, type, run_id, timestamp, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.metadata.id,
            seq,
            record.id,
            record.lane,
            record.type,
            runId,
            full.timestamp,
            JSON.stringify(full),
          );
        return full;
      }),
    );
  }

  getEntry(id: string): Promise<Entry | undefined> {
    const row = this.db
      .prepare(`SELECT payload FROM entries WHERE session_id = ? AND id = ?`)
      .get(this.metadata.id, id) as { payload: string } | undefined;
    return Promise.resolve(row === undefined ? undefined : (JSON.parse(row.payload) as Entry));
  }

  getLeafId(lane: string): Promise<string | null> {
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
    const leafId = this.readLeafId(lane);
    if (leafId === null) return Promise.resolve([]);
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id) AS (
           VALUES(?)
           UNION ALL
           SELECT e.parent_id FROM entries e JOIN chain c ON e.id = c.id
           WHERE e.session_id = ? AND e.parent_id IS NOT NULL
         )
         SELECT payload FROM entries
         WHERE session_id = ? AND id IN (SELECT id FROM chain)
         ORDER BY seq`,
      )
      .all(leafId, this.metadata.id, this.metadata.id) as { payload: string }[];
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as Entry));
  }

  findEntries(query?: EntryQuery): Promise<Entry[]> {
    const conditions = ["session_id = ?"];
    const params: SqliteValue[] = [this.metadata.id];
    if (query?.type !== undefined) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    let statement = `SELECT payload FROM entries WHERE ${conditions.join(" AND ")} ORDER BY seq`;
    if (query?.limit !== undefined) {
      statement += " LIMIT ?";
      params.push(query.limit);
    }
    const rows = this.db.prepare(statement).all(...params) as { payload: string }[];
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as Entry));
  }

  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]> {
    const conditions = ["session_id = ?", "type = ?"];
    const params: SqliteValue[] = [this.metadata.id, query.type];
    if (query.runId !== undefined) {
      conditions.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.afterSeq !== undefined) {
      conditions.push("seq > ?");
      params.push(query.afterSeq);
    }
    const rows = this.db
      .prepare(`SELECT payload FROM records WHERE ${conditions.join(" AND ")} ORDER BY seq`)
      .all(...params) as unknown as RecordRow[];
    return Promise.resolve(
      rows.map((row) => JSON.parse(row.payload) as Extract<LaneRecord, { type: K }>),
    );
  }

  findOpenOperations(lane: string): Promise<OperationStartedRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT payload FROM records
         WHERE session_id = ? AND lane = ? AND type = 'operation_started'
           AND id NOT IN (
             SELECT run_id FROM records
             WHERE session_id = ? AND type = 'operation_finished' AND run_id IS NOT NULL
           )
         ORDER BY seq DESC`,
      )
      .all(this.metadata.id, lane, this.metadata.id) as unknown as RecordRow[];
    return Promise.resolve(rows.map((row) => JSON.parse(row.payload) as OperationStartedRecord));
  }

  getLog(options?: { afterSeq?: number }): Promise<LogItem[]> {
    const after = options?.afterSeq ?? -1;
    const entryRows = this.db
      .prepare(`SELECT seq, lane, payload FROM entries WHERE session_id = ? AND seq > ?`)
      .all(this.metadata.id, after) as unknown as EntryRow[];
    const recordRows = this.db
      .prepare(`SELECT seq, payload FROM records WHERE session_id = ? AND seq > ?`)
      .all(this.metadata.id, after) as unknown as RecordRow[];
    const laneRows = this.db
      .prepare(`SELECT seq, lane, leaf_id FROM lane_moves WHERE session_id = ? AND seq > ?`)
      .all(this.metadata.id, after) as { seq: number; lane: string; leaf_id: string | null }[];
    const factRows = this.db
      .prepare(`SELECT seq, value FROM facts WHERE session_id = ? AND fact = 'name' AND seq > ?`)
      .all(this.metadata.id, after) as { seq: number; value: string }[];
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
        fact: "name",
        name: row.value,
      })),
    ];
    return Promise.resolve(log.sort((a, b) => a.seq - b.seq));
  }

  getName(): Promise<string | undefined> {
    const row = this.db
      .prepare(
        `SELECT value FROM facts WHERE session_id = ? AND fact = 'name'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(this.metadata.id) as { value: string } | undefined;
    return Promise.resolve(row?.value);
  }

  setName(name: string): Promise<void> {
    this.write(() => {
      this.db
        .prepare(`INSERT INTO facts (session_id, seq, fact, value) VALUES (?, ?, 'name', ?)`)
        .run(this.metadata.id, this.allocateSeq(1), name);
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db
        .prepare(`DELETE FROM writer_leases WHERE session_id = ? AND owner_id = ? AND fence = ?`)
        .run(this.metadata.id, this.lease.ownerId, this.lease.fence);
    }
    return Promise.resolve();
  }
}

export interface SqliteSessionRepoOptions {
  leaseTtlMs?: number;
}

export class SqliteSessionRepo implements SessionRepo, SessionSearch {
  private readonly path: string;
  private readonly leaseTtlMs: number;
  private db: DatabaseSync | undefined;
  private readonly active = new Set<SqliteSessionStorage>();

  constructor(path: string, options?: SqliteSessionRepoOptions) {
    this.path = path;
    this.leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
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
      acquireWriterLease(db, metadata.id, this.leaseTtlMs),
      this.leaseTtlMs,
    );
    this.active.add(storage);
    return storage;
  }

  async create(options?: { id?: string }): Promise<SessionStorage> {
    const db = this.database();
    const id = options?.id ?? `${new Date().toISOString().replaceAll(":", "-")}-${newId("s")}`;
    const metadata: SessionMetadata = { id, createdAt: Date.now() };
    db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = db
        .prepare(`INSERT OR IGNORE INTO sessions (id, created_at, next_seq) VALUES (?, ?, 1)`)
        .run(id, metadata.createdAt);
      if (Number(inserted.changes) !== 1) {
        throw new SessionError("storage", `Session already exists: ${id}`);
      }
      const storage = this.claim(db, metadata);
      db.exec("COMMIT");
      return storage;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A failed COMMIT has already rolled back.
      }
      throw error;
    }
  }

  async open(id: string): Promise<SessionStorage> {
    const db = this.database();
    const row = db.prepare(`SELECT id, created_at FROM sessions WHERE id = ?`).get(id) as
      | { id: string; created_at: number }
      | undefined;
    if (row === undefined) {
      throw new SessionError("not_found", `Session not found: ${id}`);
    }
    return this.claim(db, { id: row.id, createdAt: row.created_at });
  }

  async list(): Promise<SessionMetadata[]> {
    const db = this.database();
    const rows = db
      .prepare(`SELECT id, created_at FROM sessions ORDER BY created_at, id`)
      .all() as { id: string; created_at: number }[];
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
  }

  async searchEntries(
    text: string,
    options?: { limit?: number; type?: Entry["type"] },
  ): Promise<SessionSearchHit[]> {
    const query = text.trim();
    if (query.length < 3) return []; // The trigram tokenizer needs 3 or more characters.
    const db = this.database();
    const conditions = ["entries_fts MATCH ?"];
    const params: SqliteValue[] = [`"${query.replaceAll('"', '""')}"`];
    if (options?.type !== undefined) {
      conditions.push("e.type = ?");
      params.push(options.type);
    }
    const rows = db
      .prepare(
        `SELECT e.session_id, e.id, e.timestamp,
                snippet(entries_fts, 0, '', '', '…', 12) AS snippet,
                bm25(entries_fts) AS score
         FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
         WHERE ${conditions.join(" AND ")}
         ORDER BY score LIMIT ?`,
      )
      .all(...params, options?.limit ?? 20) as {
      session_id: string;
      id: string;
      timestamp: number;
      snippet: string;
      score: number;
    }[];
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
