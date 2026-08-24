import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentHarness,
  HarnessState,
  ProvisionedEntry,
  SessionStorage,
  SuspendedOperation,
  ThinkingLevel,
} from "@uji-ai/core";
import { newId } from "@uji-ai/core";
import type { ResolvedRuntime } from "./run.ts";

export interface HostedHarnessRuntimeOptions {
  model?: string;
  effort?: ThinkingLevel;
  cwd: string;
}

/** The run-state fields the host reads off its harness. `AgentHarness["state"]` supplies them. */
export interface HostedHarnessState {
  readonly isStreaming: HarnessState["isStreaming"];
  readonly isCompacting: HarnessState["isCompacting"];
  readonly thinkingLevel?: HarnessState["thinkingLevel"];
  readonly model: { readonly id: string };
}

/**
 * The slice of `AgentHarness` this host drives. Naming it keeps the host honest
 * about what it touches and lets a caller (a test, a different client) supply
 * its own runner without pretending to be the whole class.
 */
export interface HostedHarness {
  readonly session: Pick<SessionStorage, "appendEntries" | "close">;
  readonly state: HostedHarnessState;
  close: AgentHarness["close"];
  abort: AgentHarness["abort"];
  waitForIdle: AgentHarness["waitForIdle"];
}

/** The slice of `ResolvedRuntime` this host reads; the rest is the harness factory's business. */
export interface HostedRuntime {
  readonly provider: { readonly id: string };
}

export type HarnessBinding<THarness extends HostedHarness = AgentHarness> = (
  harness: THarness,
  cwd: string,
) => () => void;

export interface HarnessBindingOptions<THarness extends HostedHarness = AgentHarness> {
  /**
   * What the binding actually depends on. A replacement yielding the same key
   * keeps the standing subscription instead of tearing it down and starting a
   * new one, so a session observer survives a model, thinking level, or
   * directory change made on the same session.
   */
  dependsOn?: (harness: THarness, cwd: string) => unknown;
}

/** Structurally `typeof createHarness`, widened over the runner and runtime the host owns. */
export type CreateHostedHarness<
  THarness extends HostedHarness = AgentHarness,
  TRuntime extends HostedRuntime = ResolvedRuntime,
> = (
  runtime: TRuntime,
  session: THarness["session"],
  options: HostedHarnessRuntimeOptions,
) => Promise<{ harness: THarness; suspended: SuspendedOperation[] }>;

type StatDirectory = (path: string) => Promise<{ isDirectory(): boolean }>;
type AuthorizeWorkspace = (path: string) => Promise<string>;

interface BindingRecord<THarness extends HostedHarness> {
  bind: HarnessBinding<THarness>;
  dependsOn?: (harness: THarness, cwd: string) => unknown;
  key: unknown;
  unsubscribe: () => void;
}

/** A binding's next subscription, or its unchanged key when the standing one is kept. */
interface PreparedBinding {
  key: unknown;
  unsubscribe?: () => void;
}

interface HostedSession<THarness extends HostedHarness, TRuntime extends HostedRuntime> {
  harness: THarness;
  runtime: TRuntime;
  cwd: string;
  sessionId: string;
}

export interface HarnessHostOptions<
  THarness extends HostedHarness = AgentHarness,
  TRuntime extends HostedRuntime = ResolvedRuntime,
> {
  harness: THarness;
  runtime: TRuntime;
  sessionId: string;
  cwd: string;
  createHarness: CreateHostedHarness<THarness, TRuntime>;
  statDirectory?: StatDirectory;
  authorizeWorkspace?: AuthorizeWorkspace;
  /**
   * Called with the entries a transition is about to write, before they reach
   * the session. A client claims them here, drawing them itself instead of
   * rebuilding its view when the resulting head move arrives.
   */
  beforeAppend?: (entries: readonly ProvisionedEntry[]) => void;
}

/**
 * Owns the selected harness. Running sessions are parked when the selection
 * changes and released after their core-owned operation becomes idle.
 */
export class HarnessHost<
  THarness extends HostedHarness = AgentHarness,
  TRuntime extends HostedRuntime = ResolvedRuntime,
> {
  private currentHarness: THarness;
  private currentRuntime: TRuntime;
  private currentCwd: string;
  private currentSessionId: string;
  private readonly makeHarness: CreateHostedHarness<THarness, TRuntime>;
  private readonly statDirectory: StatDirectory;
  private readonly authorizeWorkspace: AuthorizeWorkspace;
  private readonly beforeAppend: (entries: readonly ProvisionedEntry[]) => void;
  private readonly bindings = new Set<BindingRecord<THarness>>();
  private readonly background = new Map<string, HostedSession<THarness, TRuntime>>();
  private readonly closing = new Map<string, Promise<void>>();
  private transitionTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: HarnessHostOptions<THarness, TRuntime>) {
    this.currentHarness = options.harness;
    this.currentRuntime = options.runtime;
    this.currentCwd = options.cwd;
    this.currentSessionId = options.sessionId;
    this.makeHarness = options.createHarness;
    this.statDirectory = options.statDirectory ?? stat;
    this.authorizeWorkspace = options.authorizeWorkspace ?? Promise.resolve.bind(Promise);
    this.beforeAppend = options.beforeAppend ?? (() => undefined);
  }

  get harness(): THarness {
    return this.currentHarness;
  }

  get runtime(): TRuntime {
    return this.currentRuntime;
  }

  get cwd(): string {
    return this.currentCwd;
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  bind(bind: HarnessBinding<THarness>, options: HarnessBindingOptions<THarness> = {}): () => void {
    const record: BindingRecord<THarness> = {
      bind,
      ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
      key: options.dependsOn?.(this.currentHarness, this.currentCwd),
      unsubscribe: bind(this.currentHarness, this.currentCwd),
    };
    this.bindings.add(record);
    return () => {
      if (!this.bindings.delete(record)) return;
      record.unsubscribe();
    };
  }

  switchRuntime(nextRuntime: TRuntime, nextModel: string): Promise<boolean> {
    return this.trackTransition(() => this.switchRuntimeNow(nextRuntime, nextModel));
  }

  private async switchRuntimeNow(nextRuntime: TRuntime, nextModel: string): Promise<boolean> {
    this.assertIdle("switching runtime");
    const previous = this.currentHarness;
    const previousProvider = this.currentRuntime.provider.id;
    const previousModel = previous.state.model.id;
    if (previousProvider === nextRuntime.provider.id && previousModel === nextModel) return false;

    const created = await this.makeHarness(nextRuntime, previous.session, {
      model: nextModel,
      effort: previous.state.thinkingLevel,
      cwd: this.currentCwd,
    });
    let prepared: Map<BindingRecord<THarness>, PreparedBinding>;
    try {
      this.assertOpen();
      prepared = this.prepareBindings(created.harness, this.currentCwd);
    } catch (error) {
      await created.harness.close().catch(() => undefined);
      throw error;
    }
    try {
      const changes: ProvisionedEntry[] = [];
      if (previousProvider !== nextRuntime.provider.id) {
        changes.push({
          type: "custom",
          id: newId("e"),
          customType: "provider_change",
          data: { providerId: nextRuntime.provider.id },
        });
      }
      if (previousModel !== nextModel) {
        changes.push({ type: "model_change", id: newId("e"), modelId: nextModel });
      }
      await this.recordTransition(previous.session, changes);
      this.assertOpen();
    } catch (error) {
      this.discardPrepared(prepared);
      await created.harness.close().catch(() => undefined);
      throw error;
    }

    this.commitReplacement(created.harness, nextRuntime, this.currentCwd, prepared);
    await previous.close().catch(() => undefined);
    return true;
  }

  changeDirectory(input: string): Promise<string | undefined> {
    return this.trackTransition(() => this.changeDirectoryNow(input));
  }

  private async changeDirectoryNow(input: string): Promise<string | undefined> {
    this.assertIdle("changing directory");
    const requestedCwd = resolveDirectory(this.currentCwd, input);
    const info = await this.statDirectory(requestedCwd);
    this.assertOpen();
    if (!info.isDirectory()) throw new Error(`Not a directory: ${requestedCwd}`);
    const nextCwd = await this.authorizeWorkspace(requestedCwd);
    this.assertOpen();
    if (nextCwd === this.currentCwd) return undefined;

    const previous = this.currentHarness;
    const created = await this.makeHarness(this.currentRuntime, previous.session, {
      model: previous.state.model.id,
      effort: previous.state.thinkingLevel,
      cwd: nextCwd,
    });
    let prepared: Map<BindingRecord<THarness>, PreparedBinding>;
    try {
      this.assertOpen();
      prepared = this.prepareBindings(created.harness, nextCwd);
    } catch (error) {
      await created.harness.close().catch(() => undefined);
      throw error;
    }
    try {
      await this.recordTransition(previous.session, [
        {
          type: "custom",
          id: newId("e"),
          customType: "cwd_change",
          data: { cwd: nextCwd },
        },
      ]);
      this.assertOpen();
    } catch (error) {
      this.discardPrepared(prepared);
      await created.harness.close().catch(() => undefined);
      throw error;
    }

    this.commitReplacement(created.harness, this.currentRuntime, nextCwd, prepared);
    await previous.close().catch(() => undefined);
    return nextCwd;
  }

  changeThinkingLevel(nextLevel: ThinkingLevel): Promise<boolean> {
    return this.trackTransition(() => this.changeThinkingLevelNow(nextLevel));
  }

  private async changeThinkingLevelNow(nextLevel: ThinkingLevel): Promise<boolean> {
    this.assertIdle("changing thinking level");
    const previous = this.currentHarness;
    if (previous.state.thinkingLevel === nextLevel) return false;

    const created = await this.makeHarness(this.currentRuntime, previous.session, {
      model: previous.state.model.id,
      effort: nextLevel,
      cwd: this.currentCwd,
    });
    let prepared: Map<BindingRecord<THarness>, PreparedBinding>;
    try {
      this.assertOpen();
      prepared = this.prepareBindings(created.harness, this.currentCwd);
    } catch (error) {
      await created.harness.close().catch(() => undefined);
      throw error;
    }
    try {
      await this.recordTransition(previous.session, [
        {
          type: "thinking_level_change",
          id: newId("e"),
          thinkingLevel: nextLevel,
        },
      ]);
      this.assertOpen();
    } catch (error) {
      this.discardPrepared(prepared);
      await created.harness.close().catch(() => undefined);
      throw error;
    }

    this.commitReplacement(created.harness, this.currentRuntime, this.currentCwd, prepared);
    await previous.close().catch(() => undefined);
    return true;
  }

  /**
   * Select a session without stopping work in the previous one. The opener is
   * deferred so selecting a session already parked by this host reuses its
   * harness and session handle.
   */
  activateSession(
    sessionId: string,
    openSession: () => Promise<THarness["session"]>,
  ): Promise<{ suspended: SuspendedOperation[] }> {
    return this.trackTransition(() => this.activateSessionNow(sessionId, openSession));
  }

  private async activateSessionNow(
    sessionId: string,
    openSession: () => Promise<THarness["session"]>,
  ): Promise<{ suspended: SuspendedOperation[] }> {
    this.assertOpen();
    if (sessionId === this.currentSessionId) return { suspended: [] };

    const closing = this.closing.get(sessionId);
    if (closing !== undefined) await closing;
    this.assertOpen();
    if (sessionId === this.currentSessionId) return { suspended: [] };

    const previous: HostedSession<THarness, TRuntime> = {
      harness: this.currentHarness,
      runtime: this.currentRuntime,
      cwd: this.currentCwd,
      sessionId: this.currentSessionId,
    };
    const hosted = this.background.get(sessionId);
    let destination: HostedSession<THarness, TRuntime>;
    let suspended: SuspendedOperation[] = [];
    let createdNew = false;

    if (hosted !== undefined) {
      destination = hosted;
    } else {
      const session = await openSession();
      let created: Awaited<ReturnType<CreateHostedHarness<THarness, TRuntime>>> | undefined;
      try {
        this.assertOpen();
        created = await this.makeHarness(this.currentRuntime, session, {
          model: previous.harness.state.model.id,
          effort: previous.harness.state.thinkingLevel,
          cwd: this.currentCwd,
        });
        this.assertOpen();
      } catch (error) {
        await created?.harness.close().catch(() => undefined);
        await session.close().catch(() => undefined);
        throw error;
      }
      createdNew = true;
      suspended = created.suspended;
      destination = {
        harness: created.harness,
        runtime: this.currentRuntime,
        cwd: this.currentCwd,
        sessionId,
      };
    }

    let prepared: Map<BindingRecord<THarness>, PreparedBinding>;
    try {
      prepared = this.prepareBindings(destination.harness, destination.cwd);
    } catch (error) {
      if (createdNew) {
        await destination.harness.close().catch(() => undefined);
        await destination.harness.session.close().catch(() => undefined);
      }
      throw error;
    }

    this.background.delete(sessionId);
    this.currentSessionId = sessionId;
    this.commitReplacement(destination.harness, destination.runtime, destination.cwd, prepared);
    this.parkUntilIdle(previous);
    return { suspended };
  }

  /** Select an already-opened session, closing it if this host does not consume it. */
  async switchSession(
    session: THarness["session"],
    sessionId: string,
  ): Promise<{ suspended: SuspendedOperation[] }> {
    let consumed = false;
    try {
      return await this.activateSession(sessionId, () => {
        consumed = true;
        return Promise.resolve(session);
      });
    } finally {
      if (!consumed) await session.close().catch(() => undefined);
    }
  }

  /** Close every harness and session handle owned by this host. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.transitionTail;
      const sessions = [this.currentHostedSession(), ...this.background.values()];
      const closing = [...this.closing.values()];
      this.background.clear();
      await Promise.all([
        ...sessions.map((session) => this.closeHostedSession(session)),
        ...closing,
      ]);
      this.closing.clear();
    })();
    return this.closePromise;
  }

  private currentHostedSession(): HostedSession<THarness, TRuntime> {
    return {
      harness: this.currentHarness,
      runtime: this.currentRuntime,
      cwd: this.currentCwd,
      sessionId: this.currentSessionId,
    };
  }

  private parkUntilIdle(session: HostedSession<THarness, TRuntime>): void {
    this.background.set(session.sessionId, session);
    void (async () => {
      await session.harness.waitForIdle().catch(() => undefined);
      if (this.closed || this.background.get(session.sessionId) !== session) return;
      this.background.delete(session.sessionId);
      const closing = this.closeHostedSession(session);
      this.closing.set(session.sessionId, closing);
      await closing;
      if (this.closing.get(session.sessionId) === closing) {
        this.closing.delete(session.sessionId);
      }
    })();
  }

  private async closeHostedSession(session: HostedSession<THarness, TRuntime>): Promise<void> {
    await session.harness.close().catch(() => undefined);
    await session.harness.session.close().catch(() => undefined);
  }

  private trackTransition<T>(start: () => Promise<T>): Promise<T> {
    const transition = this.transitionTail.then(start);
    this.transitionTail = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  }

  /** Offer the entries to the client, then write them, so nothing lands unclaimed. */
  private async recordTransition(
    session: THarness["session"],
    entries: readonly ProvisionedEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    this.beforeAppend(entries);
    await session.appendEntries(entries, "main");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Harness host is closed");
  }

  private assertIdle(action: string): void {
    this.assertOpen();
    if (this.currentHarness.state.isStreaming || this.currentHarness.state.isCompacting) {
      throw new Error(`Wait for the current operation before ${action}`);
    }
  }

  private prepareBindings(
    harness: THarness,
    cwd: string,
  ): Map<BindingRecord<THarness>, PreparedBinding> {
    const prepared = new Map<BindingRecord<THarness>, PreparedBinding>();
    try {
      for (const record of this.bindings) {
        const key = record.dependsOn?.(harness, cwd);
        if (record.dependsOn !== undefined && key === record.key) {
          prepared.set(record, { key });
          continue;
        }
        prepared.set(record, { key, unsubscribe: record.bind(harness, cwd) });
      }
      return prepared;
    } catch (error) {
      this.discardPrepared(prepared);
      throw error;
    }
  }

  private discardPrepared(prepared: Map<BindingRecord<THarness>, PreparedBinding>): void {
    for (const binding of prepared.values()) binding.unsubscribe?.();
  }

  private commitReplacement(
    harness: THarness,
    runtime: TRuntime,
    cwd: string,
    prepared: Map<BindingRecord<THarness>, PreparedBinding>,
  ): void {
    this.currentHarness = harness;
    this.currentRuntime = runtime;
    this.currentCwd = cwd;
    for (const record of this.bindings) {
      const next = prepared.get(record);
      // No new subscription means the binding's key held: leave it running.
      if (next?.unsubscribe === undefined) continue;
      const previous = record.unsubscribe;
      record.unsubscribe = next.unsubscribe;
      record.key = next.key;
      previous();
    }
  }
}

export function resolveDirectory(cwd: string, input: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return resolve(cwd, expanded);
}
