/**
 * Durable session coordination: heads, run claims, participant admission, and
 * cursor-based watch. SQLite implements this contract and the harness performs
 * every run write through a claimed `RunWriter`.
 *
 * Design record: packages/docs/content/docs/design.mdx. Read it before
 * changing shapes.
 *
 * The vocabulary is "head" end to end: types, columns, tables, payloads.
 * No other vocabulary ever shipped; there is no migration or compatibility
 * layer.
 *
 * - Nothing session-scoped is exclusive.
 * - Participant writes (send admission, facts, labels, custom entries while
 *   idle) are serialized by BEGIN IMMEDIATE alone. Two processes appending at
 *   one head tip both read the leaf inside their own immediate transaction and
 *   parent correctly; the store linearizes them. No lock, no rejection.
 * - Runner writes (run records, entries appended by a live run, head moves by
 *   a run) are fenced by a RUN CLAIM: at most one live claim per
 *   (session, head), compare-and-swap acquisition, fence + TTL, renewed
 *   transactionally on every runner write.
 */
import type { DatabaseSync } from "node:sqlite";
import { sql } from "./sql.ts";
import {
  newId,
  type Entry,
  type LogItem,
  type MessageEntry,
  type NewRecord,
  type OperationFinishedRecord,
  type ProvisionedEntry,
  type RunRecord,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Admission (sdk.messages.send at the storage layer)
// ---------------------------------------------------------------------------

/** Who sent this, as the host defines identity. Attribution, not authorization. */
export interface SendOrigin {
  readonly clientId?: string;
  readonly userId?: string;
  readonly device?: string;
}

export interface SendOptions {
  /** Head to send into. Default "main". */
  readonly head?: string;
  /**
   * How a send behind a live run is delivered at the runner's next checkpoint:
   * "steer" drains at the next turn boundary, "queue" when the run would
   * otherwise stop. Ignored when the head is idle (the send is placed).
   */
  readonly delivery?: "steer" | "queue";
  readonly origin?: SendOrigin;
  /**
   * Caller-supplied idempotency key. A retry with the same key returns the
   * original receipt with `duplicate: true` and writes nothing. Each write-once
   * receipt persists for the session's lifetime, so storage is bounded by the
   * client's key generation. Pruning requires a future schema migration.
   */
  readonly idempotencyKey?: string;
}

export type SendReceipt =
  | {
      /** No live claim on the head: the entry was appended at the tip. A run is wanted. */
      disposition: "placed";
      entryId: string;
      duplicate: boolean;
    }
  | {
      /** A live run holds the head: the send is a durable pending item that run will drain. */
      disposition: "queued";
      entryId: string;
      runId: string;
      duplicate: boolean;
    };

/*
 * send(input, options) — ONE immediate transaction:
 *
 *   TX[
 *     if options.idempotencyKey exists in send_keys:
 *       return recorded receipt with duplicate: true            // write nothing
 *     claim := live claim on (session, head)                    // expires_at_ms > now
 *     if claim is undefined:
 *       entry := writeEntry(message entry at head tip)          // + head move, one seq each
 *       receipt := { disposition: "placed", entryId }
 *     else:
 *       record queue_enqueued { queue: delivery == "queue" ? "followUp" : "steer",
 *                               runId: claim.runId, target: provisioned entry }
 *       receipt := { disposition: "queued", entryId, runId }
 *     if options.idempotencyKey: insert send_keys(key -> receipt)
 *     return receipt
 *   ]
 *
 * Disposition is decided INSIDE the transaction that reads the claim; there is
 * no window where a claim starts between the read and the write. Rejection
 * because someone else is talking must not exist (design record invariant 5).
 * Pending consumption/cancellation semantics are unchanged from today: an item
 * is consumed exactly when its target entry exists, cancelled exactly when a
 * queue_cancelled record names it.
 */

// ---------------------------------------------------------------------------
// Run claims (design record: "Runs claim heads; nothing claims a session")
// ---------------------------------------------------------------------------

export interface RunClaim {
  readonly head: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly fence: number;
  readonly expiresAtMs: number;
}

export type ClaimOutcome =
  | { ok: true; claim: RunClaim }
  | { ok: false; holder: { runId: string; ownerId: string; expiresAtMs: number } };

export const RUN_CLAIMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_claims (
  session_id TEXT NOT NULL,
  head TEXT NOT NULL,
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, head)
) WITHOUT ROWID;

-- Write-once idempotency receipts persist for the session lifetime, one row
-- per caller key. Retention or pruning is a future schema-evolution step.
CREATE TABLE IF NOT EXISTS send_keys (
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS run_claim_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  head TEXT NOT NULL,
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  expires_at_ms INTEGER,
  action TEXT NOT NULL CHECK (action IN ('acquired', 'renewed', 'released')),
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
`;

/**
 * Claims one run on one head. CAS: the upsert succeeds only when no claim row
 * exists for the head or the existing one has expired; a takeover increments
 * the fence, which invalidates every write the previous claimant might still
 * attempt. Losing the race is an expected outcome, not an error: the loser's
 * input (if any) is already admitted and the winner will drain it.
 *
 * Fence reset after release is safe because writes are guarded on
 * (owner_id, fence) together, and owner ids are fresh random ids per claim.
 */
export function acquireRunClaim(
  db: DatabaseSync,
  sessionId: string,
  head: string,
  runId: string,
  ttlMs: number,
): ClaimOutcome {
  const now = Date.now();
  const row = sql`INSERT INTO run_claims (session_id, head, run_id, owner_id, fence, expires_at_ms)
    VALUES (${sessionId}, ${head}, ${runId}, ${newId("c")}, 1, ${now + ttlMs})
    ON CONFLICT(session_id, head) DO UPDATE SET
      run_id = excluded.run_id,
      owner_id = excluded.owner_id,
      fence = run_claims.fence + 1,
      expires_at_ms = excluded.expires_at_ms
    WHERE run_claims.expires_at_ms <= ${now}
    RETURNING run_id, owner_id, fence, expires_at_ms`.get<{
    run_id: string;
    owner_id: string;
    fence: number;
    expires_at_ms: number;
  }>(db);
  if (row === undefined) {
    const holder = readLiveClaim(db, sessionId, head);
    // A losing CAS with no surviving holder means the holder finished between
    // our two statements; the caller retries its claim.
    if (holder === undefined) return acquireRunClaim(db, sessionId, head, runId, ttlMs);
    return {
      ok: false,
      holder: {
        runId: holder.runId,
        ownerId: holder.ownerId,
        expiresAtMs: holder.expiresAtMs,
      },
    };
  }
  return {
    ok: true,
    claim: {
      head,
      runId: row.run_id,
      ownerId: row.owner_id,
      fence: row.fence,
      expiresAtMs: row.expires_at_ms,
    },
  };
}

/**
 * Extends the claim iff this claimant still holds it. Matched on
 * (owner, fence) alone; expiry is deliberately not checked. Expiry lets a
 * successor take over after a crash; it does not kill a claimant merely
 * because its clock jumped while the process was suspended. Zero rows matched
 * means fenced out: terminal for this claimant.
 */
export function renewRunClaim(
  db: DatabaseSync,
  sessionId: string,
  claim: RunClaim,
  expiresAtMs: number,
): boolean {
  const result = sql`UPDATE run_claims SET expires_at_ms = ${expiresAtMs}
    WHERE session_id = ${sessionId}
      AND head = ${claim.head}
      AND owner_id = ${claim.ownerId}
      AND fence = ${claim.fence}`.run(db);
  return Number(result.changes) === 1;
}

/** Releases only this claimant's own claim; a successor's row never matches. */
export function releaseRunClaim(db: DatabaseSync, sessionId: string, claim: RunClaim): boolean {
  const result = sql`DELETE FROM run_claims
    WHERE session_id = ${sessionId}
      AND head = ${claim.head}
      AND owner_id = ${claim.ownerId}
      AND fence = ${claim.fence}`.run(db);
  return Number(result.changes) === 1;
}

/** The live (unexpired) claim on a head, if any. Readers use this for RunInfo. */
export function readLiveClaim(
  db: DatabaseSync,
  sessionId: string,
  head: string,
): RunClaim | undefined {
  const row = sql`SELECT run_id, owner_id, fence, expires_at_ms FROM run_claims
    WHERE session_id = ${sessionId} AND head = ${head}
      AND expires_at_ms > ${Date.now()}`.get<{
    run_id: string;
    owner_id: string;
    fence: number;
    expires_at_ms: number;
  }>(db);
  if (row === undefined) return undefined;
  return {
    head,
    runId: row.run_id,
    ownerId: row.owner_id,
    fence: row.fence,
    expiresAtMs: row.expires_at_ms,
  };
}

// ---------------------------------------------------------------------------
// Runner writes (fenced by a claim)
// ---------------------------------------------------------------------------

/**
 * The write set a live run uses, bound to its claim. Every method runs inside
 * one immediate transaction that first renews the claim; a fenced-out claimant
 * dies before touching data.
 *
 * Obtained from DurableSessionStore.claimRun; release() or expiry ends it.
 * After release, every method throws SessionError("storage").
 */
export interface RunWriter {
  readonly claim: RunClaim;
  /** Aborts when a successor fences this writer out. Release does not abort it. */
  readonly claimLost: AbortSignal;
  appendEntry(entry: ProvisionedEntry): Promise<Entry>;
  appendEntries(entries: readonly ProvisionedEntry[]): Promise<Entry[]>;
  /** Applies all currently pending deferred writes atomically in admission order. */
  applyDeferred(): Promise<Entry[]>;
  appendRecord<TRecord extends RunRecord>(record: NewRecord<TRecord>): Promise<TRecord>;
  /** Deliberate re-point (navigation). Appends a head move; never deletes entries. */
  moveHead(to: string | null): Promise<void>;
  renew(): Promise<boolean>;
  /**
   * Atomically applies every unconsumed deferred write in record order, writes
   * the terminal record, and releases this claim. Admission racing this commit
   * either joins the reconciliation or observes an idle head.
   */
  finish(record: NewRecord<OperationFinishedRecord>): Promise<{
    record: OperationFinishedRecord;
    deferredEntries: Entry[];
  }>;
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Watch (design record: "One event stream, one cursor")
// ---------------------------------------------------------------------------

export interface WatchOptions {
  /** Replay durable items with seq > afterSeq, then stream live ones. */
  readonly afterSeq?: number;
  readonly signal?: AbortSignal;
}

/*
 * watch(options) — AsyncIterable<LogItem>:
 *
 *   1. Replay: yield getLog({ afterSeq }) in seq order.
 *   2. Live: yield every durable item committed after the replay point, in seq
 *      order, without gaps or duplicates (track the last yielded seq; re-query
 *      with afterSeq = lastSeq on every wake).
 *
 * Wake sources, encapsulated in the store so no CLIENT ever polls:
 *   - In-process: notify watchers after every committed write transaction.
 *   - Cross-process (second process on the same SQLite file): poll
 *     `PRAGMA data_version` on a short interval while watchers exist; it
 *     changes iff another connection committed. On change, re-query by cursor.
 *
 * Ephemeral overlays (streaming deltas, tool progress) are NOT storage events;
 * they belong to the runner's host (design record: "One event stream, one
 * cursor") and reference the
 * provisioned entry id they settle into. A client that misses them recovers
 * the settled entry from this stream (invariant 18).
 */

// ---------------------------------------------------------------------------
// The store contract the SQLite backend implements
// ---------------------------------------------------------------------------

export type ClaimRunOutcome =
  | { ok: true; claim: RunClaim; writer: RunWriter }
  | { ok: false; holder: { runId: string; ownerId: string; expiresAtMs: number } };

export type EntryAdmission = { disposition: "placed" } | { disposition: "deferred"; runId: string };

/**
 * Every open session handle gets these participant and execution-coordination
 * verbs. Opening grants reads plus participation; execution rights come only
 * from claimRun.
 */
export interface DurableSessionStore {
  send(input: string | MessageEntry["message"], options?: SendOptions): Promise<SendReceipt>;
  /**
   * Concurrency-safe tree admission (design record: "Admission is open"). An idle head receives the
   * entry immediately. A live run receives a durable `deferred_write` that its
   * claimant applies before steering at a checkpoint. Deferred targets use the
   * same `queue_cancelled` entry-id tombstones as queued messages.
   */
  admitEntry(entry: ProvisionedEntry, head?: string): Promise<EntryAdmission>;
  /** Records an abort request for the live claimant in the same transaction. */
  requestAbort(head?: string): Promise<{ runId: string } | undefined>;
  /** The live claim on a head, if any: sdk.runs.current at the storage layer. */
  getLiveClaim(head: string): Promise<RunClaim | undefined>;
  /** CAS a run onto a head. Expected loss is a value, not an error. */
  claimRun(head: string, runId: string): Promise<ClaimRunOutcome>;
  watch(options?: WatchOptions): AsyncIterable<LogItem>;
}
