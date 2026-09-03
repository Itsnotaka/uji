/**
 * Durable AgentHarness host facade. Admission and reads go to the store;
 * execution composes the stateless runner in runner.ts.
 *
 * Per the locked core-to-harness rule this composition drives the standalone
 * loop; the loop knows nothing about it.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/agent-harness.ts
 * and https://github.com/earendil-works/pi/blob/dev/packages/coding-agent/src/core/agent-session.ts
 */
import { acquireSessionResources } from "@uji-ai/ai/session-resources";
import type { RetryPolicy } from "@uji-ai/ai/utils/retry";
import type { Api, Model, Skill } from "@uji-ai/schema";
import {
  isThinkingLevel,
  type AgentTool,
  type QueueMode,
  type StreamFn,
  type ThinkingLevel,
} from "../types.ts";
import { createRegistries, PluginHost, type HarnessRegistries } from "../plugins/host.ts";
import { pluginFactKey } from "../plugins/storage.ts";
import type {
  Agent,
  ApplySettingOutcome,
  Command,
  LoadedPlugin,
  PluginEnv,
  SettingInfo,
} from "../plugins/types.ts";
import type {
  AbortOutcome,
  CancelOutcome,
  CompactOutcome,
  EphemeralEvent,
  MoveOutcome,
  RedeliverOutcome,
} from "../sdk/types.ts";
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  type CompactionSettings,
} from "./compaction/compaction.ts";
import { DEFAULT_RETRY_POLICY, validateCompactionSettings, validateRetryPolicy } from "./config.ts";
import { HookRegistry } from "./hooks.ts";
import {
  drive,
  finishedFromRecord,
  resumeDrive,
  type RunnerFinished,
  type RunnerOptions,
  type RunOutcome,
  type StepResult,
} from "./runner.ts";
import type { RunWriter } from "./session/store.ts";
import { newId } from "./session/types.ts";
import type {
  Entry,
  MessageEntry,
  NavigationIntent,
  QueueEnqueuedRecord,
  RunConfig,
  RunIntent,
  SessionStorage,
} from "./session/types.ts";
import { readSessionConfig } from "./session/context.ts";
import { hasWakeInput } from "./session/run-state.ts";
import type { AgentHarnessStreamOptions } from "./types.ts";
import { navigationTarget } from "../views/tree.ts";

export type { CompactionOutcome, NavigationOutcome, OperationError, RunOutcome } from "./runner.ts";

const HEAD = "main";
const REGISTRY_PROPERTIES = [
  // `agents` first: the `subagents` builtin reads it while contributing `tools`.
  "agents",
  "tools",
  "commands",
  "prompt",
  "resources",
  "settings",
] satisfies readonly (keyof HarnessRegistries)[];

export interface NavigateOptions {
  /** The entry selected in the tree, or null for the start of the chat. */
  readonly entryId: string | null;
  /** Summarize the branch being left; the summary lands at the destination. */
  readonly summary?: { readonly customInstructions?: string };
}

/** A loop tool plus its crash-replay policy and durable wake handler (pi HarnessTool). */
export type HarnessTool = AgentTool;

export interface AgentHarnessOptions {
  session: SessionStorage;
  streamFn: StreamFn;
  /** Everything the harness exposes to the model comes from these. Built-ins are plugins too. */
  plugins: readonly LoadedPlugin[];
  env: PluginEnv;
  /** Fallback: the model a run uses when the branch's config names none. */
  model: Model<Api>;
  /**
   * Resolves a branch-config model ref against the host's catalog. A ref
   * without a provider matches by id alone. Omitted, or returning undefined,
   * falls back to `model`: an unknown ref degrades, never fails a run.
   */
  resolveModel?: (ref: { provider?: string; id: string }) => Model<Api> | undefined;
  thinkingLevel?: ThinkingLevel;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  /** Provider request defaults applied before per-run options and request hooks. */
  streamOptions?: AgentHarnessStreamOptions;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  /**
   * A run this process drove reached its terminal record. A park on waiting
   * calls is not an end; a lost claim is, reported as `claim_lost`.
   */
  onRunEnd?: (finished: RunnerFinished) => void;
}

function isUserMessageEntry(entry: Entry): entry is MessageEntry {
  return entry.type === "message" && entry.message.role === "user";
}

/** An agent's `provider/model` ref; a bare id resolves against every provider. */
function parseModelRef(ref: string): { provider?: string; id: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return { id: ref };
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export class AgentHarness {
  readonly session: SessionStorage;
  readonly hooks: HookRegistry;
  readonly plugins: PluginHost;
  readonly env: PluginEnv;
  readonly registries: HarnessRegistries = createRegistries();

  private readonly options: AgentHarnessOptions;
  private readonly listeners = new Set<(event: EphemeralEvent) => void | Promise<void>>();
  private readonly releaseSessionResources: () => void;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly attachments = new Set<AbortController>();
  /**
   * Operations this process is driving right now, by run id. What separates
   * work this harness owns — aborted and awaited on close — from work another
   * process owns, which close must leave alone (claim-neutral close).
   */
  private readonly localDrives = new Map<string, Promise<void>>();

  private constructor(options: AgentHarnessOptions, releaseSessionResources: () => void) {
    validateRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
    validateCompactionSettings(options.compaction ?? DEFAULT_COMPACTION_SETTINGS);
    this.options = options;
    this.releaseSessionResources = releaseSessionResources;
    this.session = options.session;
    this.env = options.env;
    this.plugins = new PluginHost(this);
    this.hooks = new HookRegistry((error, hook) =>
      this.emit({ kind: "diagnostic", owner: `hook ${hook}`, level: "error", message: error.message }),
    );
  }

  static async create(options: AgentHarnessOptions): Promise<AgentHarness> {
    const sessionId = (await options.session.getMetadata()).id;
    const harness = new AgentHarness(options, acquireSessionResources(sessionId));
    try {
      await harness.plugins.activate(options.plugins);
      return harness;
    } catch (error) {
      await harness.close().catch(() => undefined);
      throw error;
    }
  }

  subscribe(listener: (event: EphemeralEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTools(): HarnessTool[] {
    return this.registries.tools.values();
  }

  /** The declared agents. A client renders these; the `subagents` builtin projects them. */
  getAgents(): readonly Agent[] {
    return this.registries.agents.values();
  }

  getCommands(): ReadonlyMap<string, Command> {
    return this.registries.commands.current();
  }

  /** Plugin that contributed a command's current shape, for provenance a client renders. */
  commandOwner(name: string): string | undefined {
    return this.registries.commands.owner(name);
  }

  getResources(): ReadonlyMap<string, Skill> {
    return this.registries.resources.current();
  }

  /** Every setting with its owner and current choice, for a client to render. */
  async listSettings(): Promise<readonly SettingInfo[]> {
    const settings: SettingInfo[] = [];
    for (const [id, setting] of this.registries.settings.current()) {
      const owner = this.registries.settings.owner(id);
      if (owner === undefined) continue;
      const stored = await this.session.getFact(pluginFactKey(owner, setting.key));
      const current =
        typeof stored === "string" && setting.choices.some((choice) => choice.id === stored)
          ? stored
          : (setting.fallback ?? setting.choices[0].id);
      settings.push({ id, owner, label: setting.label, choices: setting.choices, current });
    }
    return settings;
  }

  /** Write a setting's choice to its owner's storage. Callers re-list; there is no cached value. */
  async applySetting(id: string, choiceId: string): Promise<ApplySettingOutcome> {
    const setting = this.registries.settings.get(id);
    const owner = this.registries.settings.owner(id);
    if (setting === undefined || owner === undefined) return { kind: "not_found" };
    if (!setting.choices.some((choice) => choice.id === choiceId)) {
      return { kind: "invalid_choice" };
    }
    await this.session.setFact(pluginFactKey(owner, setting.key), choiceId);
    return { kind: "applied" };
  }

  getSystemPrompt(): string {
    return this.registries.prompt
      .values()
      .map((section, index) => ({ section, index }))
      .sort(
        (left, right) =>
          (left.section.order ?? 100) - (right.section.order ?? 100) || left.index - right.index,
      )
      .map(({ section }) => section.text)
      .join("\n\n");
  }

  async runCommand(name: string, argument = ""): Promise<string | undefined> {
    const command = this.registries.commands.get(name);
    if (command === undefined) throw new Error(`unknown command: ${name}`);
    return (await command.run(argument)) ?? undefined;
  }

  rebuildAll(): void {
    for (const property of REGISTRY_PROPERTIES) {
      for (const failure of this.registries[property].rebuild().errors) {
        void this.emit({
          kind: "diagnostic",
          level: "error",
          owner: failure.owner,
          message: failure.message,
        });
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    for (const attachment of this.attachments) attachment.abort();
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const errors: unknown[] = [];
    // Claim-neutral close (design record, "Who runs?"): only work this
    // process is driving is aborted and awaited. An operation another process
    // owns — or an orphan nobody owns — is left exactly as it stands; a mere
    // observer closing must not stop a live run or hang on one.
    if (this.localDrives.size > 0) {
      await this.abortOperation().catch((error: unknown) => errors.push(error));
      await Promise.all(this.localDrives.values()).catch(() => undefined);
    }
    await this.plugins.close().catch((error: unknown) => errors.push(error));
    try {
      this.hooks.close(new Error("harness is closed"));
    } catch (error) {
      errors.push(error);
    }
    try {
      this.releaseSessionResources();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close harness");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("harness is closed");
  }

  async cancelQueued(entryId: string): Promise<CancelOutcome> {
    this.assertOpen();
    const known = (await this.session.findRecords({ type: "queue_enqueued" })).some(
      (record) => record.target.id === entryId,
    );
    if (!known) return { kind: "not_found" };
    const pending = (await this.pendingQueueRecords()).some(
      (record) => record.target.id === entryId,
    );
    if (!pending) return { kind: "already_consumed" };
    await this.session.appendRecord({
      type: "queue_cancelled",
      id: newId("r"),
      head: HEAD,
      entryId,
    });
    return { kind: "cancelled" };
  }

  /**
   * Move a message that is still waiting between lanes: a follow-up becomes a
   * steer the running turn takes at its next boundary, a steer falls back
   * behind the run. Delivery is a property of a pending item, not a decision
   * frozen when it was sent, so a client can offer "send this one now" without
   * cancelling and re-typing — which would lose the message's place in line and
   * its entry id.
   *
   * It is a second `queue_enqueued` for the same provisioned entry rather than
   * a new record type: both projections that read the queue already keep the
   * last record per target id, and the first record still fixes the item's
   * position, so a re-delivered message keeps the place it has always held.
   *
   * Based on OpenCode v2's inbox, where `steer`, `queue`, and `cancel` are
   * three verbs over one pending item:
   * https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/inbox.ts
   */
  async redeliverQueued(entryId: string, delivery: "steer" | "queue"): Promise<RedeliverOutcome> {
    this.assertOpen();
    const known = (await this.session.findRecords({ type: "queue_enqueued" })).some(
      (record) => record.target.id === entryId,
    );
    if (!known) return { kind: "not_found" };
    const record = (await this.pendingQueueRecords()).find(
      (candidate) => candidate.target.id === entryId,
    );
    if (record === undefined) return { kind: "already_consumed" };
    const queue = delivery === "queue" ? "followUp" : "steer";
    // Moving a lane is a compare-and-set on the lane it is leaving, so an item
    // already there means the caller's view of the queue was stale.
    if (record.queue === queue) return { kind: "unchanged", delivery };
    await this.session.appendRecord({
      type: "queue_enqueued",
      id: newId("r"),
      head: HEAD,
      queue,
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      target: record.target,
    });
    // A steer with no live run has nothing to drain it, so the re-delivery is
    // also the wake: the same nudge `abort({ continue: true })` relies on. The
    // caller asked to change a lane, not to sit through the turn, so the drive
    // detaches; it does wait for the claim, so a run is already running by the
    // time this resolves.
    if (delivery === "steer") await this.wakePendingSteers({ detach: true });
    return { kind: "redelivered", delivery };
  }

  async compact(options: { customInstructions?: string } = {}): Promise<CompactOutcome> {
    while (true) {
      this.assertOpen();
      const branch = await this.session.getBranch(HEAD);
      const preparation = prepareCompaction(
        branch,
        this.options.compaction ?? DEFAULT_COMPACTION_SETTINGS,
      );
      if (!preparation.ok || preparation.value === undefined) {
        return { kind: "nothing_to_compact" };
      }

      const runId = newId("compact");
      const claimed = await this.session.beginOperation(HEAD, runId, {
        intent: {
          kind: "compaction",
          ...(options.customInstructions === undefined
            ? {}
            : { customInstructions: options.customInstructions }),
        },
        ...(await this.operationConfig()),
      });
      if (!claimed.ok) {
        await this.awaitFinished(claimed.holder.runId);
        continue;
      }
      const finished = await this.startDrive(runId, { recover: false, writer: claimed.writer });
      if (finished.operation !== "compaction") {
        throw new Error(`Compaction ${runId} finished as ${finished.operation}`);
      }
      switch (finished.outcome.kind) {
        case "completed":
          return { kind: "compacted", entryId: finished.outcome.entry.id };
        case "aborted":
          return { kind: "failed", message: "compaction aborted" };
        case "failed":
          return { kind: "failed", message: finished.outcome.error.message };
        default: {
          const _exhaustive: never = finished.outcome;
          return _exhaustive;
        }
      }
    }
  }

  /**
   * Re-point the head as a durable structural run (design record: "Heads are
   * named pointers"). A user message hands itself back through `restored`
   * while the head parks on its parent; anything else becomes the leaf. With
   * `summary`, the branch being left is summarized and the summary entry is
   * appended at the destination, so the next send parents on it. Abandoned
   * entries are never deleted.
   */
  async navigate(options: NavigateOptions): Promise<MoveOutcome> {
    while (true) {
      this.assertOpen();
      const selected =
        options.entryId === null ? undefined : await this.session.getEntry(options.entryId);
      if (options.entryId !== null && selected === undefined) return { kind: "not_found" };
      const target = navigationTarget(selected);
      // The summary decision needs the leaf; beginOperation re-reads it in-tx
      // for the record itself.
      const sourceLeafId = await this.session.getLeafId(HEAD);
      // Already there: the asked-for state holds, so the move is a no-op success.
      if (target.kind === "move" && target.targetId === sourceLeafId) {
        return { kind: "moved", seq: await this.session.lastSeq() };
      }

      const runId = newId("nav");
      const intent: NavigationIntent = {
        kind: "navigation",
        selectedId: options.entryId,
        targetId: target.targetId,
        ...(options.summary === undefined || sourceLeafId === null
          ? {}
          : {
              summary: {
                entryId: newId("e"),
                ...(options.summary.customInstructions === undefined
                  ? {}
                  : { customInstructions: options.summary.customInstructions }),
              },
            }),
      };
      const claimed = await this.session.beginOperation(HEAD, runId, {
        intent,
        ...(await this.operationConfig()),
      });
      if (!claimed.ok) {
        await this.awaitFinished(claimed.holder.runId);
        continue;
      }
      const finished = await this.startDrive(runId, { recover: false, writer: claimed.writer });
      if (finished.operation !== "navigation") {
        throw new Error(`Navigation ${runId} finished as ${finished.operation}`);
      }
      switch (finished.outcome.kind) {
        case "completed":
          return {
            kind: "moved",
            seq: await this.session.lastSeq(),
            ...(target.kind === "restore" && target.entry.message.role === "user"
              ? {
                  restored: { entryId: target.entry.id, content: target.entry.message.content },
                }
              : {}),
          };
        case "aborted":
          return { kind: "aborted" };
        case "failed":
          return { kind: "failed", message: finished.outcome.error.message };
        default: {
          const _exhaustive: never = finished.outcome;
          return _exhaustive;
        }
      }
    }
  }

  async abort(options: { continue?: boolean } = {}): Promise<AbortOutcome> {
    this.assertOpen();
    const runId = await this.abortOperation(options);
    return runId === undefined ? { kind: "not_running" } : { kind: "requested", runId };
  }

  private async abortOperation(options: { continue?: boolean } = {}): Promise<string | undefined> {
    let operation = (await this.session.findOpenOperations(HEAD))[0];
    if (operation === undefined) {
      const claim = await this.session.getLiveClaim(HEAD);
      if (claim === undefined) return undefined;
      operation = await this.waitForOperationStart(claim.runId);
    }
    try {
      await this.session.appendRecord({
        type: "abort_requested",
        id: newId("r"),
        head: HEAD,
        runId: operation.id,
        ...(options.continue === true ? { continueSteers: true } : {}),
      });
    } catch (error) {
      await this.session.requestAbort(HEAD);
      throw error;
    }
    return operation.id;
  }

  /**
   * Drive the head's open operation in this process, or report who holds it.
   * Resume is for orphans (design record, "Who runs?"): an open operation
   * under a live claim is running in some process, and this harness must not
   * contest it; the claim CAS in the runner still guards the window between
   * this read and the claim, and losing it is a value, never a failed run.
   * `undefined` means nothing is open.
   */
  async resume(): Promise<Exclude<StepResult, { kind: "continue" }> | undefined> {
    this.assertOpen();
    const operation = (await this.session.findOpenOperations(HEAD))[0];
    if (operation === undefined) return undefined;
    const live = await this.session.getLiveClaim(HEAD);
    if (live !== undefined) {
      return {
        kind: "claimed_elsewhere",
        head: HEAD,
        holder: { runId: live.runId, ownerId: live.ownerId, expiresAtMs: live.expiresAtMs },
      };
    }
    return this.driveLocal(operation.id, { recover: true });
  }

  /**
   * Volunteer this process as a runner for the head (design record:
   * "Admission is open", who runs).
   * Whenever the head is idle with work pending, ensure a run: pick up an
   * orphaned open operation, start a run for a user message any process placed
   * after the last operation, or wake queued steers. Attached hosts race on the
   * claim CAS and losers do nothing, so attaching from several processes is safe.
   */
  attach(): () => void {
    const controller = new AbortController();
    this.attachments.add(controller);
    void this.attachLoop(controller.signal)
      .catch((error: unknown) => this.reportRunnerError(error))
      .finally(() => this.attachments.delete(controller));
    return () => controller.abort();
  }

  private async attachLoop(signal: AbortSignal): Promise<void> {
    let cursor = -1;
    let scannedTo = await this.ensureRun(cursor);
    cursor = scannedTo.cursor;
    for await (const item of this.session.watch({ afterSeq: cursor, signal })) {
      cursor = item.seq;
      if (this.closed) return;
      if (item.kind === "fact" || item.kind === "fact_value") continue;
      scannedTo = await this.ensureRun(scannedTo.afterOperation);
    }
  }

  /**
   * One idle-head check over the log since the last operation record. Returns
   * the seq to scan from next time so the check stays incremental.
   */
  private async ensureRun(afterSeq: number): Promise<{ cursor: number; afterOperation: number }> {
    const log = await this.session.getLog({ afterSeq });
    let cursor = afterSeq;
    let afterOperation = afterSeq;
    let placedSeq = -1;
    for (const item of log) {
      cursor = item.seq;
      if (
        item.kind === "entry" &&
        item.head === HEAD &&
        isUserMessageEntry(item.entry) &&
        item.entry.wake !== false
      ) {
        placedSeq = item.seq;
      }
      if (
        item.kind === "record" &&
        (item.record.type === "operation_started" || item.record.type === "operation_finished")
      ) {
        afterOperation = item.seq;
      }
    }
    await this.wakeHead(placedSeq > afterOperation);
    return { cursor, afterOperation };
  }

  /**
   * Volunteer this process as the runner for an idle head: pick up an
   * orphaned open operation, start a run for placed input, or wake queued
   * steers. The drive it starts runs detached; its failure is a diagnostic.
   * Attached hosts race on the claim CAS and losers do nothing, so calling
   * this from several processes is safe.
   */
  private async wakeHead(placed: boolean): Promise<void> {
    if (this.closed || (await this.session.getLiveClaim(HEAD)) !== undefined) return;
    const open = (await this.session.findOpenOperations(HEAD))[0];
    let started: Promise<RunnerFinished> | undefined;
    if (open !== undefined) {
      if (!(await this.shouldWake(open.id))) return;
      started = this.startDrive(open.id, { recover: true });
    } else if (!placed) {
      await this.wakePendingSteers();
      return;
    } else {
      const run = await this.startRun({ kind: "run", originalPrompt: [], initialMessages: [] });
      if (run === undefined) return;
      started = this.startDrive(run.runId, { recover: false, writer: run.writer });
    }
    void started.catch((error: unknown) => this.reportRunnerError(error));
  }

  /**
   * An orphan always resumes. A waiting run resumes only when wake input
   * arrived after its claim released, or an abort is pending, so the attach
   * loop does not spin on a run that is parked on purpose.
   */
  private async shouldWake(runId: string): Promise<boolean> {
    const state = await this.session.runState(runId);
    if (state.kind !== "running") return false;
    if (state.waitingCalls.length === 0) return true;
    return hasWakeInput(state);
  }

  private reportRunnerError(error: unknown): Promise<void> {
    return this.emit({
      kind: "diagnostic",
      level: "error",
      owner: "runner",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  async emit(event: EphemeralEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        // A listener failure is contained (invariant 21) and reported once;
        // a diagnostic that fails to deliver is not reported again.
        if (event.kind === "diagnostic") continue;
        await this.emit({
          kind: "diagnostic",
          level: "error",
          owner: `listener ${event.kind}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Drive one operation to its terminal record in this process. A writer from
   * admission rides in so the claim is held from `operation_started` to the
   * terminal record with no orphan-shaped gap. A waiting run parked durably:
   * local driving is over (so close stays claim-neutral), and the caller's
   * completion resolves on the terminal record whichever process eventually
   * writes it.
   */
  private async startDrive(runId: string, mode: DriveMode): Promise<RunnerFinished> {
    const stopped = await this.driveLocal(runId, mode);
    switch (stopped.kind) {
      case "waiting":
        return this.awaitFinished(runId);
      case "finished":
        return stopped;
      case "claimed_elsewhere":
        return this.toFacadeFinished(runId, stopped);
      default: {
        const _exhaustive: never = stopped;
        return _exhaustive;
      }
    }
  }

  /**
   * Run the runner under this process's ownership, tracked in `localDrives`
   * so close can tell work it owns from work another process owns. `recover`
   * repairs an orphan's effect sandwich first.
   */
  private async driveLocal(
    runId: string,
    mode: DriveMode,
  ): Promise<Exclude<StepResult, { kind: "continue" }>> {
    const driven = (async () => {
      const options = await this.runnerOptions(runId);
      return mode.recover ? resumeDrive(options) : drive(options, { writer: mode.writer });
    })();
    this.localDrives.set(
      runId,
      driven.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      const stopped = await driven;
      if (stopped.kind === "waiting") return stopped;
      const finished = await this.toFacadeFinished(runId, stopped);
      if (finished.operation === "run") this.options.onRunEnd?.(finished);
      await this.afterDrive(finished);
      return stopped;
    } finally {
      this.localDrives.delete(runId);
    }
  }

  private async toFacadeFinished(
    runId: string,
    stopped: Exclude<StepResult, { kind: "continue" | "waiting" }>,
  ): Promise<RunnerFinished> {
    switch (stopped.kind) {
      case "finished":
        return stopped;
      case "claimed_elsewhere": {
        const state = await this.session.runState(runId);
        if (state.kind === "missing") throw new Error(`Run ${runId} disappeared`);
        const message =
          stopped.holder.runId === runId
            ? `Run ${runId} is already claimed by another runner`
            : `Head ${stopped.head} is claimed by ${stopped.holder.runId}`;
        const outcome = {
          kind: "failed",
          leafId: state.operation.sourceLeafId,
          error: { code: "claim_lost", message },
        } satisfies RunOutcome;
        switch (state.operation.intent.kind) {
          case "run":
            return { kind: "finished", operation: "run", runId, outcome };
          case "compaction":
            return { kind: "finished", operation: "compaction", runId, outcome };
          case "navigation":
            return { kind: "finished", operation: "navigation", runId, outcome };
          default: {
            const _exhaustive: never = state.operation.intent;
            return _exhaustive;
          }
        }
      }
      default: {
        const _exhaustive: never = stopped;
        return _exhaustive;
      }
    }
  }

  /**
   * A run wakes the steers it left behind. So does a navigation: a message
   * sent while the head was being re-pointed was queued behind that claim in
   * admission order, and it belongs to the branch the head now points at.
   */
  private async afterDrive(finished: RunnerFinished): Promise<void> {
    if (finished.operation === "compaction" || this.closed) return;
    const state = await this.session.runState(finished.runId);
    const continueSteers =
      state.kind !== "missing" && state.abortRequested?.continueSteers === true;
    const wake = finished.outcome.kind !== "failed" || finished.outcome.error.code !== "claim_lost";
    if (wake && (finished.outcome.kind !== "aborted" || continueSteers)) {
      await this.wakePendingSteers();
    }
  }

  /**
   * `detach` starts the run without sitting through it. A run that ended wants
   * the next one chained onto its own completion; a participant that only
   * moved a message between lanes wants the run observable and its own call
   * back.
   */
  private async wakePendingSteers(options: { detach?: boolean } = {}): Promise<void> {
    if (this.closed || (await this.session.getLiveClaim(HEAD)) !== undefined) return;
    if (!(await this.pendingQueueRecords()).some((record) => record.queue === "steer")) return;
    const open = (await this.session.findOpenOperations(HEAD))[0];
    let woken: Promise<unknown>;
    if (open !== undefined) {
      // An orphan resumes for its pending input; a waiting run does not,
      // because steers are not wake input (they drain after the settlement).
      if (!(await this.shouldWake(open.id))) return;
      woken = this.resume();
    } else {
      const started = await this.startRun({
        kind: "run",
        originalPrompt: [],
        initialMessages: [],
        promotionScope: "steer",
      });
      if (started === undefined) return;
      woken = this.startDrive(started.runId, { recover: false, writer: started.writer });
    }
    if (options.detach === true) {
      void woken.catch((error: unknown) => this.reportRunnerError(error));
      return;
    }
    await woken;
  }

  /**
   * Claim the head and record operation_started; undefined when another
   * runner won the claim. The claim stays held and rides into the drive.
   */
  private async startRun(
    intent: RunIntent,
  ): Promise<{ runId: string; writer: RunWriter } | undefined> {
    const runId = newId("run");
    const claimed = await this.session.beginOperation(HEAD, runId, {
      intent,
      ...(await this.operationConfig()),
    });
    if (!claimed.ok) return undefined;
    return { runId, writer: claimed.writer };
  }

  /**
   * The branch's run inputs at operation start, spreadable into the record.
   * Empty config stays off the record entirely, so a session that never
   * configured anything writes the same record it always did.
   */
  private async operationConfig(): Promise<{ config?: RunConfig }> {
    const config = readSessionConfig(await this.session.getBranch(HEAD));
    return config.model === undefined &&
      config.thinkingLevel === undefined &&
      config.agent === undefined
      ? {}
      : { config };
  }

  /**
   * Run inputs come from the operation record, re-resolved against this
   * host's catalog: the durable artifact is the name, and an unknown name
   * degrades to the fallback instead of failing the run.
   */
  private async runnerOptions(runId: string): Promise<RunnerOptions> {
    const state = await this.session.runState(runId);
    const config = state.kind === "missing" ? undefined : state.operation.config;
    // The driving agent re-resolves against this host's registry (invariant
    // 29); an unknown or disabled id degrades to the fallbacks. An explicit
    // branch declaration outranks the agent's default model: the agent record
    // fixes its default, the user's `model_change` is the stronger declaration.
    const agent =
      config?.agent === undefined
        ? undefined
        : this.getAgents().find(
            (candidate) => candidate.id === config.agent && candidate.disabled !== true,
          );
    const model =
      config?.model !== undefined
        ? (this.options.resolveModel?.(config.model) ?? this.options.model)
        : agent?.model !== undefined
          ? (this.options.resolveModel?.(parseModelRef(agent.model)) ?? this.options.model)
          : this.options.model;
    const thinkingLevel =
      config?.thinkingLevel !== undefined && isThinkingLevel(config.thinkingLevel)
        ? config.thinkingLevel
        : this.options.thinkingLevel;
    const steps = agent?.steps;
    const systemPrompt =
      agent?.system === undefined
        ? this.getSystemPrompt()
        : `${this.getSystemPrompt()}\n\n${agent.system}`;
    return {
      session: this.session,
      runId,
      hooks: this.hooks,
      streamFn: this.options.streamFn,
      tools: this.getTools(),
      model,
      systemPrompt,
      emit: (event) => this.emit(event),
      thinkingLevel,
      ...(steps === undefined ? {} : { steps }),
      retry: this.options.retry,
      compaction: this.options.compaction,
      streamOptions: this.options.streamOptions,
      steeringMode: this.options.steeringMode,
      followUpMode: this.options.followUpMode,
    };
  }

  private async awaitFinished(runId: string): Promise<RunnerFinished> {
    const initial = await this.session.runState(runId);
    if (initial.kind === "finished") {
      return finishedFromRecord(initial, await this.session.getLeafId(HEAD));
    }
    for await (const item of this.session.watch()) {
      if (
        item.kind !== "record" ||
        item.record.type !== "operation_finished" ||
        item.record.runId !== runId
      ) {
        continue;
      }
      const state = await this.session.runState(runId);
      if (state.kind === "finished") {
        return finishedFromRecord(state, await this.session.getLeafId(HEAD));
      }
    }
    throw new Error(`Session closed before ${runId} finished`);
  }

  private async waitForOperationStart(runId: string): Promise<OperationStarted> {
    const existing = await this.session.runState(runId);
    if (existing.kind !== "missing") return existing.operation;
    for await (const item of this.session.watch()) {
      if (
        item.kind === "record" &&
        item.record.type === "operation_started" &&
        item.record.id === runId
      ) {
        return item.record;
      }
    }
    throw new Error(`Session closed before ${runId} started`);
  }

  private async pendingQueueRecords(): Promise<QueueEnqueuedRecord[]> {
    const latestByEntry = new Map<string, QueueEnqueuedRecord>();
    for (const record of await this.session.findRecords({ type: "queue_enqueued" })) {
      latestByEntry.set(record.target.id, record);
    }
    const cancelled = new Set(
      (await this.session.findRecords({ type: "queue_cancelled" })).map((record) => record.entryId),
    );
    const pending: QueueEnqueuedRecord[] = [];
    for (const record of latestByEntry.values()) {
      if (cancelled.has(record.target.id)) continue;
      if ((await this.session.getEntry(record.target.id)) !== undefined) continue;
      pending.push(record);
    }
    return pending;
  }
}

/** Recover an orphan under a fresh claim, or drive under the claim admission already holds. */
type DriveMode = { recover: true } | { recover: false; writer: RunWriter };
type OperationStarted = Extract<
  Awaited<ReturnType<SessionStorage["findOpenOperations"]>>[number],
  { type: "operation_started" }
>;
