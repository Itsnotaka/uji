/**
 * The ephemeral overlay for one open session, folded from `watch` events.
 *
 * Durable events refresh one core session snapshot, so transcript, pending,
 * metadata, and context move together at one cursor.
 * Ephemeral events accumulate here, keyed by the part identity deltas carry
 * (entry id + content index, or tool call id — invariant 18), and every buffer
 * dies when its settled entry arrives or the run finishes. Losing this state
 * loses animation frames, never conversation.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Seq, SessionEvent, SessionId, ToolProgress } from "@uji-ai/core";
import { refreshThread } from "./queries.ts";
import { uji } from "./uji.ts";

export type LiveRunState = "idle" | "working" | "compacting" | "navigating" | "retrying";

export type LivePartRef =
  | { kind: "text"; entryId: string; contentIndex: number }
  | { kind: "thinking"; entryId: string; contentIndex: number }
  | { kind: "tool"; callId: string; entryId: string };

export interface LiveSnapshot {
  readonly runState: LiveRunState;
  readonly retry?: { attempt: number; maxAttempts: number; at: number; message: string };
  /** Streaming text by `${entryId}:${contentIndex}`. */
  readonly text: ReadonlyMap<string, string>;
  readonly thinking: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, { entryId: string; progress: ToolProgress }>;
  /** Arrival order of in-flight parts, for rendering the live turn. */
  readonly order: readonly LivePartRef[];
  readonly diagnostics: readonly { owner: string; level: "warn" | "error"; message: string }[];
}

const IDLE: LiveSnapshot = {
  runState: "idle",
  text: new Map(),
  thinking: new Map(),
  tools: new Map(),
  order: [],
  diagnostics: [],
};

const partKey = (entryId: string, contentIndex: number): string =>
  `${entryId}:${String(contentIndex)}`;

class LiveStore {
  snapshot: LiveSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private frame: number | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LiveSnapshot => this.snapshot;

  update(next: LiveSnapshot): void {
    this.snapshot = next;
    this.frame ??= window.requestAnimationFrame(() => {
      this.frame = undefined;
      for (const listener of this.listeners) listener();
    });
  }

  settle(entryIds: ReadonlySet<string>): void {
    let next = this.snapshot;
    for (const entryId of entryIds) {
      const buffered =
        next.order.some((ref) => ref.entryId === entryId) ||
        [...next.tools.values()].some((tool) => tool.entryId === entryId);
      if (buffered) next = dropEntry(next, entryId);
    }
    if (next !== this.snapshot) this.update(next);
  }
}

function appendDelta(
  buffers: ReadonlyMap<string, string>,
  key: string,
  delta: string,
): Map<string, string> {
  const next = new Map(buffers);
  next.set(key, (next.get(key) ?? "") + delta);
  return next;
}

function withOrder(order: readonly LivePartRef[], ref: LivePartRef): readonly LivePartRef[] {
  const exists = order.some((existing) =>
    existing.kind === "tool" && ref.kind === "tool"
      ? existing.callId === ref.callId
      : existing.kind === ref.kind &&
        existing.kind !== "tool" &&
        ref.kind !== "tool" &&
        existing.entryId === ref.entryId &&
        existing.contentIndex === ref.contentIndex,
  );
  return exists ? order : [...order, ref];
}

/** Drop every buffer that settled into this entry. */
function dropEntry(snapshot: LiveSnapshot, entryId: string): LiveSnapshot {
  const strip = (buffers: ReadonlyMap<string, string>): Map<string, string> => {
    const next = new Map(buffers);
    for (const key of next.keys()) if (key.startsWith(`${entryId}:`)) next.delete(key);
    return next;
  };
  const tools = new Map(snapshot.tools);
  for (const [callId, tool] of tools) if (tool.entryId === entryId) tools.delete(callId);
  return {
    ...snapshot,
    text: strip(snapshot.text),
    thinking: strip(snapshot.thinking),
    tools,
    order: snapshot.order.filter((ref) => ref.entryId !== entryId),
  };
}

function fold(store: LiveStore, sessionId: SessionId, event: SessionEvent): void {
  const snapshot = store.snapshot;

  switch (event.kind) {
    case "synced":
      return;
    case "message":
      // Keep the overlay until a snapshot at this sequence contains it.
      refreshThread(sessionId, event.seq);
      return;
    case "run_started": {
      const { retry: _settledRetry, ...current } = snapshot;
      store.update({
        ...current,
        runState:
          event.operation === "compaction"
            ? "compacting"
            : event.operation === "navigation"
              ? "navigating"
              : "working",
      });
      refreshThread(sessionId, event.seq);
      return;
    }
    case "run_finished": {
      const { retry: _settledRetry, ...current } = snapshot;
      store.update({ ...current, runState: "idle" });
      refreshThread(sessionId, event.seq);
      return;
    }
    case "run_waiting": {
      const { retry: _settledRetry, ...current } = snapshot;
      store.update({ ...current, runState: "idle" });
      refreshThread(sessionId, event.seq);
      return;
    }
    case "queued":
    case "queue_consumed":
    case "queue_cancelled":
    case "compaction":
    case "name_changed":
    case "head_moved":
      refreshThread(sessionId, event.seq);
      return;
    case "claim":
      return;
    case "text_delta": {
      const key = partKey(event.entryId, event.contentIndex);
      store.update({
        ...snapshot,
        runState: snapshot.runState === "idle" ? "working" : snapshot.runState,
        text: appendDelta(snapshot.text, key, event.delta),
        order: withOrder(snapshot.order, {
          kind: "text",
          entryId: event.entryId,
          contentIndex: event.contentIndex,
        }),
      });
      return;
    }
    case "reasoning_delta": {
      const key = partKey(event.entryId, event.contentIndex);
      store.update({
        ...snapshot,
        runState: snapshot.runState === "idle" ? "working" : snapshot.runState,
        thinking: appendDelta(snapshot.thinking, key, event.delta),
        order: withOrder(snapshot.order, {
          kind: "thinking",
          entryId: event.entryId,
          contentIndex: event.contentIndex,
        }),
      });
      return;
    }
    case "tool_progress": {
      const tools = new Map(snapshot.tools);
      tools.set(event.callId, { entryId: event.entryId, progress: event.progress });
      store.update({
        ...snapshot,
        runState: snapshot.runState === "idle" ? "working" : snapshot.runState,
        tools,
        order: withOrder(snapshot.order, {
          kind: "tool",
          callId: event.callId,
          entryId: event.entryId,
        }),
      });
      return;
    }
    case "retry_scheduled":
      store.update({
        ...snapshot,
        runState: "retrying",
        retry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          at: event.at,
          message: event.message,
        },
      });
      return;
    case "retry_started": {
      const { retry: _dropped, ...rest } = snapshot;
      store.update({ ...rest, runState: "working" });
      return;
    }
    case "compacting":
      store.update({ ...snapshot, runState: "compacting" });
      return;
    case "plugins_changed":
      return;
    case "diagnostic":
      store.update({
        ...snapshot,
        diagnostics: [
          ...snapshot.diagnostics.slice(-2),
          { owner: event.owner, level: event.level, message: event.message },
        ],
      });
      return;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * One live watch for one open session. The core snapshot's seq is the replay
 * cursor, so commits between the read and subscription cannot be lost.
 */
export function useSessionLive(
  sessionId: SessionId,
  afterSeq: Seq | undefined,
  settledEntries: ReadonlySet<string>,
): LiveSnapshot {
  const store = storeFor(sessionId);
  const connection = useRef<{ stop: () => void } | undefined>(undefined);
  useEffect(() => store.settle(settledEntries), [settledEntries, store]);
  useEffect(() => {
    // Latch the first coherent cursor for this mount. Later snapshot refreshes
    // must not restart the live stream and drop ephemeral frames.
    if (afterSeq === undefined || connection.current !== undefined) return;
    let stopped = false;
    let reconnectTimer: number | undefined;
    let disposeWatch: (() => void) | undefined;
    let watchCursor = afterSeq;
    let failures = 0;

    const connect = (): void => {
      if (stopped) return;
      disposeWatch = uji.watch(
        { sessionId, afterSeq: watchCursor },
        (event) => {
          failures = 0;
          if ("seq" in event) watchCursor = event.seq;
          fold(store, sessionId, event);
        },
        () => {
          if (stopped) return;
          disposeWatch?.();
          disposeWatch = undefined;
          refreshThread(sessionId, watchCursor);
          const delay = Math.min(250 * 2 ** failures, 4_000);
          failures += 1;
          reconnectTimer = window.setTimeout(connect, delay);
        },
      );
    };

    connect();
    connection.current = {
      stop: () => {
        stopped = true;
        if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
        disposeWatch?.();
      },
    };
  }, [afterSeq, connection, sessionId, store]);
  useEffect(
    () => () => {
      connection.current?.stop();
      connection.current = undefined;
      store.update({ ...IDLE, diagnostics: store.snapshot.diagnostics });
    },
    [connection, store],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

const stores = new Map<string, LiveStore>();

function storeFor(sessionId: SessionId): LiveStore {
  const existing = stores.get(sessionId);
  if (existing !== undefined) return existing;
  const created = new LiveStore();
  stores.set(sessionId, created);
  return created;
}
