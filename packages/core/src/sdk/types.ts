/**
 * The SDK contract: what a client sees, and nothing else. Every type here is a
 * plain interface or a `kind`-discriminated union with no class instances and
 * no methods on data, so the protocol layer can mirror these verbs one to one
 * over a wire later without reshaping anything.
 *
 * Argued in the design record: `packages/docs/content/docs/design.mdx`, "The SDK".
 */
import type { Api, JsonValue, Model, Skill, UserMessage } from "@uji-ai/schema";
import type { StreamFn, ThinkingLevel } from "../types.ts";
import type { ContextStatus } from "../views/context.ts";
import type { FileChange } from "../views/changes.ts";
import type { Turn } from "../views/transcript.ts";

export type { FileChange } from "../views/changes.ts";
import type { Disposer, LoadedPlugin, PluginInfo, SettingInfo } from "../plugins/types.ts";
import type { CompactionSettings } from "../harness/compaction/compaction.ts";
import type { SessionRepo } from "../harness/session/types.ts";
import type { ToolReplyAdmission } from "../harness/session/store.ts";
export type { ToolReplyAdmission } from "../harness/session/store.ts";
import type { AgentHarnessStreamOptions } from "../harness/types.ts";
import type { WorkspaceInfo, WorkspaceRegistryBackend } from "../workspace-registry.ts";

export type { WorkspaceInfo, WorkspaceRegistryBackend } from "../workspace-registry.ts";

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

/**
 * Ids are opaque to clients: created by the store, and every field carrying one
 * is named for what it holds (`entryId`, `runId`, `head`, `seq`), so a value one
 * verb returns is spelled the same as the argument the next verb takes.
 *
 * `SessionId` is the only one a client ever types by hand — a CLI flag, a route
 * param — so it is the only one that is parsed, and `sessionId` is the single
 * place it is minted. The rest travel between verbs and are aliases: branding
 * them bought nothing the field names do not already say, and cost forty
 * unchecked assertions minting them out of the store's plain strings.
 */
export type SessionId = string & { readonly __brand: "SessionId" };
export type EntryId = string;
export type RunId = string;
export type HeadName = string;
export type Seq = number;

/** Parse an untrusted string as a session id. The boundary a CLI flag crosses. */
export function sessionId(value: string): SessionId {
  if (value === "") throw new Error("Invalid session id: empty");
  return value as SessionId;
}

/** The default head. Every verb that takes `head` falls back to it. */
export const MAIN: HeadName = "main";

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface HeadInfo {
  readonly name: HeadName;
  readonly entryId: EntryId | null;
  readonly run?: RunInfo;
}

/**
 * The durable parent link a task spawn writes at creation, before the child's
 * first admission, so a crashed spawn retried lands the child exactly once and
 * a picker can hide children (design.mdx, "Agents").
 */
export interface SessionParent {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly callId: string;
  readonly agent: string;
  readonly depth: number;
}

export interface SessionInfo {
  readonly sessionId: SessionId;
  readonly name?: string;
  readonly preview?: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly heads: readonly HeadInfo[];
  /**
   * The run inputs the branch currently declares, folded from its
   * `model_change`, `thinking_level_change`, and `agent_change` entries. Absent
   * members mean the branch never declared a choice; runs fall back to the
   * host's defaults. The agent is re-resolved against the running host's
   * registry at run start.
   */
  readonly config: {
    readonly model?: { readonly provider?: string; readonly id: string };
    readonly thinkingLevel?: ThinkingLevel;
    readonly agent?: string;
  };
  /** Present on a child session; written at creation. */
  readonly parent?: SessionParent;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next?: string;
}

export interface SessionSnapshot {
  /** The last durable item included. Pass this to `watch` for gap-free continuation. */
  readonly seq: Seq;
  readonly session: SessionInfo;
  readonly transcript: readonly Turn[];
  readonly pending: readonly PendingItem[];
  readonly context: ContextStatus;
}

export interface Sessions {
  create(input?: {
    sessionId?: SessionId;
    name?: string;
    /** Written before first admission; what makes a session a child. */
    parent?: SessionParent;
  }): Promise<SessionInfo>;
  get(input: { sessionId: SessionId }): Promise<SessionInfo | undefined>;
  /** A complete client read model projected at one durable cursor. */
  snapshot(input: { sessionId: SessionId; head?: HeadName }): Promise<SessionSnapshot | undefined>;
  /** `parent: null` selects roots, the user-facing picker's filter; an id selects its children. */
  list(input?: {
    search?: string;
    limit?: number;
    cursor?: string;
    parent?: SessionId | null;
  }): Promise<Page<SessionInfo>>;
  rename(input: { sessionId: SessionId; name: string }): Promise<void>;
  /** Aborts any live run, waits for the head to go idle, then deletes. */
  delete(input: { sessionId: SessionId }): Promise<void>;
  /**
   * Declare run inputs by appending configuration entries to the tree. An
   * idle head applies them now; a live head defers them to the run's next
   * checkpoint, where they drive the following run. The tree is the carrier,
   * so the choice survives restart and reaches whichever process runs next.
   */
  configure(input: {
    sessionId: SessionId;
    model?: { provider: string; id: string };
    thinkingLevel?: ThinkingLevel;
    /** Validated against the session's agent registry; runs re-resolve the name (invariant 29). */
    agent?: string;
  }): Promise<ConfigureOutcome>;
}

export type ConfigureOutcome =
  | { kind: "applied" }
  | { kind: "deferred"; runId: RunId }
  | { kind: "unknown_model" }
  | { kind: "unknown_agent" };

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export interface SendInput {
  readonly sessionId: SessionId;
  /** Caller-supplied idempotency: the first admission wins and a retry is a duplicate. */
  readonly entryId?: EntryId;
  readonly content: UserMessage["content"];
  readonly delivery?: "steer" | "queue";
  readonly head?: HeadName;
  /** Default true. `false` admits without asking a host to run, for batch import. */
  readonly wake?: boolean;
  /**
   * Declares the driving agent for the run this send wakes, admitted as an
   * `agent_change` entry before the message. Unvalidated here; the run start
   * re-resolves the name and an unknown one degrades to the fallbacks.
   */
  readonly agent?: string;
}

export type SendReceipt =
  | { kind: "placed"; entryId: EntryId }
  | { kind: "queued"; entryId: EntryId; runId: RunId }
  | { kind: "duplicate"; entryId: EntryId };

export type CancelOutcome =
  | { kind: "cancelled" }
  | { kind: "already_consumed" }
  | { kind: "not_found" };

export type RedeliverOutcome =
  | { kind: "redelivered"; delivery: "steer" | "queue" }
  /** Pending, but already in the asked-for lane: the caller's view was stale. */
  | { kind: "unchanged"; delivery: "steer" | "queue" }
  | { kind: "already_consumed" }
  | { kind: "not_found" };

export interface PendingItem {
  readonly entryId: EntryId;
  readonly delivery: "steer" | "queue" | "nextRun";
  /** Queue targets are admitted user messages, so the content is user-shaped. */
  readonly content: UserMessage["content"];
}

export interface Messages {
  send(input: SendInput): Promise<SendReceipt>;
  cancel(input: { sessionId: SessionId; entryId: EntryId }): Promise<CancelOutcome>;
  /**
   * Move a still-pending item between lanes. Delivery is a property of the
   * item, not a decision frozen at send, so "send this one now" keeps the
   * message's id and its place in line instead of cancelling and re-sending.
   */
  redeliver(input: {
    sessionId: SessionId;
    entryId: EntryId;
    delivery: "steer" | "queue";
  }): Promise<RedeliverOutcome>;
  /** The transcript projection: what a client renders. */
  list(input: { sessionId: SessionId; head?: HeadName }): Promise<readonly Turn[]>;
  pending(input: { sessionId: SessionId; head?: HeadName }): Promise<readonly PendingItem[]>;
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/** How a run ended, as the terminal record alone knows it. */
export type RunEnd =
  | { kind: "completed" }
  | { kind: "aborted" }
  | { kind: "failed"; error: { message: string } };

export type RunInfo =
  | {
      kind: "live";
      runId: RunId;
      head: HeadName;
      startedAt: number;
      claim: { ownerId: string; expiresAt: number };
    }
  | { kind: "orphaned"; runId: RunId; head: HeadName; startedAt: number; expiredAt: number }
  /**
   * Parked on waiting tool calls, holding no claim and no process (design
   * record, "Wait and wake"). Wake input arrives by admission; abort is
   * always an exit.
   */
  | { kind: "waiting"; runId: RunId; head: HeadName; startedAt: number };

export type AbortOutcome = { kind: "requested"; runId: RunId } | { kind: "not_running" };

export type CompactOutcome =
  | { kind: "compacted"; entryId: EntryId }
  | { kind: "nothing_to_compact" }
  | { kind: "failed"; message: string };

/**
 * How a `wait` resolved. A waiting run may wait for input forever, so a
 * caller that blocked on "done" learns to render the question instead of
 * hanging; a headless client prints it and exits.
 */
export type WaitOutcome = { kind: "idle" } | { kind: "waiting"; runId: RunId };

export interface Runs {
  /** Read from the claim, never from memory: a run another process owns reads the same. */
  current(input: { sessionId: SessionId; head?: HeadName }): Promise<RunInfo | undefined>;
  abort(input: { sessionId: SessionId; runId?: RunId; continue?: boolean }): Promise<AbortOutcome>;
  /** Resolves when the head is idle, or when its run parks with no wake input pending. */
  wait(input: {
    sessionId: SessionId;
    head?: HeadName;
    signal?: AbortSignal;
  }): Promise<WaitOutcome>;
  /**
   * Answer one waiting tool call directly: the ask reply channel. Targets
   * an explicit call id, or the head's sole live wait matching
   * `toolName`. First writer wins, and the reply never enters the
   * conversation, so it cannot be mistaken for a message and a message
   * cannot be mistaken for it.
   */
  reply(input: {
    sessionId: SessionId;
    toolCallId?: string;
    toolName?: string;
    reply: JsonValue;
    head?: HeadName;
  }): Promise<ToolReplyAdmission>;
  compact(input: {
    sessionId: SessionId;
    head?: HeadName;
    customInstructions?: string;
  }): Promise<CompactOutcome>;
  /**
   * Per-file totals folded from settled patches; `runId` scopes to that run's
   * operation bracket on its own head, and an unknown run reports nothing.
   * Declared mutations only: whole-tree truth is `workspace.vcs`.
   */
  changes(input: {
    sessionId: SessionId;
    head?: HeadName;
    runId?: RunId;
  }): Promise<readonly FileChange[]>;
  /** The context gauge: tokens and share of the window of the model the next run would use. */
  context(input: { sessionId: SessionId; head?: HeadName }): Promise<ContextStatus>;
}

// ---------------------------------------------------------------------------
// heads
// ---------------------------------------------------------------------------

export type MoveOutcome =
  | {
      kind: "moved";
      seq: Seq;
      /**
       * Present when the selected entry was a user message: the head parked on
       * its parent and the message is handed back, so a client can offer it
       * for editing instead of replaying it.
       */
      restored?: { entryId: EntryId; content: UserMessage["content"] };
    }
  | { kind: "busy"; run: RunInfo }
  | { kind: "not_found" }
  /** The navigation was stopped, e.g. its branch summary was aborted; the head did not move. */
  | { kind: "aborted" }
  /** The navigation run failed, e.g. the branch summary could not be generated. */
  | { kind: "failed"; message: string };

export interface Heads {
  /**
   * Re-point the head as a durable structural run: it claims the head exactly
   * as compaction does, so nothing moves under a live run's feet. With
   * `summary`, the branch being left is summarized and the summary entry lands
   * at the destination.
   */
  move(input: {
    sessionId: SessionId;
    head?: HeadName;
    to: EntryId | null;
    summary?: { customInstructions?: string };
  }): Promise<MoveOutcome>;
}

// ---------------------------------------------------------------------------
// workspace and provider
// ---------------------------------------------------------------------------

export interface VcsStatus {
  readonly branch?: string;
  readonly files: readonly {
    readonly path: string;
    readonly kind: "added" | "modified" | "deleted" | "untracked";
  }[];
}

export interface VcsDiff {
  readonly path: string;
  readonly patch: string;
}

/** The host-supplied effect behind `workspace.vcs`. */
export interface VcsBackend {
  status(): Promise<VcsStatus>;
  diff(input?: { paths?: readonly string[] }): Promise<readonly VcsDiff[]>;
}

export interface Workspace {
  /**
   * Workspaces this user has opened, newest first, from the host's registry
   * (`UjiOptions.workspaces`). Empty when the host supplies none. A picker or
   * welcome screen renders this; over the wire it is a verb like any other.
   */
  list(): Promise<readonly WorkspaceInfo[]>;
  /** Remove one workspace from the registry. A no-op without a registry. */
  forget(input: { path: string }): Promise<void>;
  /**
   * Whole-tree truth the changes view cannot see (bash side effects). Core
   * owns the verb so a wire can carry it; the host supplies the backend;
   * omitted answers empty. Snapshot, revert, and worktree verbs are refused:
   * entries are immutable and `heads.move` is the revert.
   */
  vcs: {
    status(): Promise<VcsStatus | undefined>;
    diff(input?: { paths?: readonly string[] }): Promise<readonly VcsDiff[]>;
  };
}

export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly contextWindow?: number;
}

export interface Provider {
  models: { list(): Promise<readonly ModelInfo[]>; default(): Promise<ModelInfo | undefined> };
}

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

export interface CommandInfo {
  readonly name: string;
  /** Plugin id. */
  readonly owner: string;
  readonly description: string;
}

export type CommandOutcome =
  | { kind: "ran"; output?: string }
  | { kind: "not_found" }
  | { kind: "failed"; message: string };

export type ApplyOutcome = { kind: "applied" } | { kind: "not_found" } | { kind: "invalid_choice" };

export interface Plugins {
  list(input: { sessionId: SessionId }): Promise<readonly PluginInfo[]>;
  commands: {
    list(input: { sessionId: SessionId }): Promise<readonly CommandInfo[]>;
    run(input: { sessionId: SessionId; name: string; argument?: string }): Promise<CommandOutcome>;
  };
  settings: {
    list(input: { sessionId: SessionId }): Promise<readonly SettingInfo[]>;
    apply(input: { sessionId: SessionId; id: string; choiceId: string }): Promise<ApplyOutcome>;
  };
  resources: { list(input: { sessionId: SessionId }): Promise<readonly Skill[]> };
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export type DurableEvent = { readonly seq: Seq } & (
  | { kind: "message"; entryId: EntryId; turn: Turn }
  | { kind: "head_moved"; head: HeadName; to: EntryId | null; by: "append" | "move" }
  /**
   * Run boundaries carry what their records know, nothing more. Claim state
   * arrives as `claim` events; usage is a fold over the run's usage records
   * (`projectRunUsage`). An event that claimed either would be fabricating.
   * `operation` is the intent kind, so a client renders "compacting" or
   * "navigating" without reading records.
   */
  | {
      kind: "run_started";
      runId: RunId;
      head: HeadName;
      startedAt: number;
      operation: "run" | "compaction" | "navigation";
      /** The declared driving agent the record folded at run start. */
      agent?: string;
    }
  | { kind: "run_finished"; runId: RunId; head: HeadName; finishedAt: number; outcome: RunEnd }
  /**
   * A tool call settled as waiting: the run parked, holding nothing, and
   * its claim released. One event per waiting call; the settlement arrives
   * later as the reserved entry's `message` event.
   */
  | {
      kind: "run_waiting";
      runId: RunId;
      head: HeadName;
      toolCallId: string;
      toolName: string;
      /** The call's validated arguments: everything a client needs to render the ask. */
      args: JsonValue;
    }
  | {
      kind: "claim";
      head: HeadName;
      runId: RunId;
      state: "acquired" | "renewed" | "released" | "expired";
    }
  | { kind: "queued"; item: PendingItem }
  | { kind: "queue_consumed"; entryId: EntryId }
  | { kind: "queue_cancelled"; entryId: EntryId }
  | { kind: "compaction"; entryId: EntryId; summary: string }
  | { kind: "name_changed"; name: string }
  /** Replay is complete and the client's first render is whole; live follows. */
  | { kind: "synced" }
);

/** A tool's partial output as it runs. The settled result arrives as the durable entry. */
export interface ToolProgress {
  readonly text: string;
  /** Heading the tool chose for this call, e.g. the path it is reading. */
  readonly title?: string;
  /**
   * The same field the settlement writes, previewed live, so one renderer
   * reads one shape running or settled. A partial that does not round-trip
   * through JSON drops rather than throws (invariant 31).
   */
  readonly details?: JsonValue;
}

export type EphemeralEvent =
  // Deltas carry part identity (entry id and content index), the same identity
  // transcript parts carry, so a renderer appends to the right block when an
  // assistant message interleaves text, tool calls, and more text.
  | { kind: "text_delta"; entryId: EntryId; contentIndex: number; delta: string }
  | { kind: "reasoning_delta"; entryId: EntryId; contentIndex: number; delta: string }
  | { kind: "tool_progress"; entryId: EntryId; callId: string; progress: ToolProgress }
  /** A transient failure is owed another attempt at `at`; `message` names the cause. */
  | {
      kind: "retry_scheduled";
      runId: RunId;
      attempt: number;
      maxAttempts: number;
      at: number;
      message: string;
    }
  /** The retried call is back in flight; a client clears its wait banner. */
  | { kind: "retry_started"; runId: RunId; attempt: number }
  /**
   * Context compaction is running inside a live run. Manual compaction is its
   * own operation and arrives as `run_started`; threshold and overflow
   * compaction happen mid-run, where only an overlay can say so. The result is
   * the durable `compaction` event either way.
   */
  | { kind: "compacting"; runId: RunId; reason: "manual" | "threshold" | "overflow" }
  // Host notifications: nothing durable to settle into, re-derivable by a list call.
  | { kind: "plugins_changed"; plugins: readonly PluginInfo[] }
  | { kind: "diagnostic"; owner: string; level: "warn" | "error"; message: string };

export type SessionEvent = DurableEvent | EphemeralEvent;

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class UjiClosed extends Error {
  readonly kind = "closed" as const;
  constructor() {
    super("uji is closed");
    this.name = "UjiClosed";
  }
}

export class UnknownSession extends Error {
  readonly kind = "not_found" as const;
  readonly what = "session" as const;
  constructor(id: string) {
    super(`Unknown session: ${id}`);
    this.name = "UnknownSession";
  }
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

export type { Disposer };

export interface AttachOptions {
  /** Attach only to these sessions. Omitted means every session this store holds. */
  readonly sessions?: readonly SessionId[];
}

export interface UjiOptions {
  /** The only storage type a host names. From `@uji-ai/core/store`. */
  readonly store: SessionRepo;
  /** Explicit, never a global registry. */
  readonly streamFn: StreamFn;
  /** Resolves model refs; provider auth lives here. */
  readonly models: ModelCatalog;
  /** Fallback: the model a run uses when the session's branch declares none. */
  readonly model: Model<Api>;
  /** Fallback thinking level when the branch declares none. */
  readonly thinkingLevel?: ThinkingLevel;
  /** Resolved by the host behind workspace trust; built-ins included. */
  readonly plugins: readonly LoadedPlugin[];
  /** Where tools run. */
  readonly env: { readonly cwd: string };
  readonly compaction?: CompactionSettings;
  /** Provider request defaults applied before per-run options and request hooks. */
  readonly streamOptions?: AgentHarnessStreamOptions;
  /** Consulted by `workspace.vcs`; omitted answers empty. */
  readonly vcs?: VcsBackend;
  /**
   * Consulted by `workspace.list` and `workspace.forget`; `createUji` records
   * `env.cwd` in it, because composing a Uji over a workspace is opening it.
   * Omitted, the list is empty and nothing is recorded.
   */
  readonly workspaces?: WorkspaceRegistryBackend;
}

/** The slice of `@uji-ai/ai`'s `Models` the SDK reads. A host may pass the whole thing. */
export interface ModelCatalog {
  getModels(provider?: string): readonly Model<Api>[];
  getModel(provider: string, id: string): Model<Api> | undefined;
}

export interface Uji {
  readonly sessions: Sessions;
  readonly messages: Messages;
  readonly runs: Runs;
  readonly heads: Heads;
  readonly workspace: Workspace;
  readonly provider: Provider;
  readonly plugins: Plugins;
  /**
   * Replay durable items from the cursor, emit `synced`, then interleave live
   * durable items with ephemeral overlays. Reconnect is the same call with the
   * last seq seen; no client keeps other bookkeeping. `live: true` skips the
   * replay and starts at the tip; the first event is still `synced`, so the
   * two arms cannot contradict each other.
   */
  watch(
    input: { sessionId: SessionId; signal?: AbortSignal } & ({ afterSeq?: Seq } | { live: true }),
  ): AsyncIterable<SessionEvent>;
  /**
   * Volunteer this process as a runner. A thin client never calls it. Each
   * call is one attachment and its disposer withdraws exactly that one; a
   * session has a runner while any attachment covers it, including sessions
   * created or opened after the attachment was made.
   */
  attach(input?: AttachOptions): Disposer;
  /**
   * Replace the resolved plugin list: a plugin-file edit, a manifest change.
   * Host verb like `attach`; the host resolves behind trust and hands the
   * result over. Every open session re-activates against the new list and
   * `plugins_changed` reaches its watchers; sessions opened later start from
   * it.
   */
  setPlugins(plugins: readonly LoadedPlugin[]): Promise<void>;
  close(): Promise<void>;
}
