import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@uji-ai/ai/models";
import type { Api, Model, ModelThinkingLevel } from "@uji-ai/ai/types";
import { createUji } from "@uji-ai/core";
import type {
  Disposer,
  ModelCatalog,
  Seq,
  SessionEvent,
  SessionId,
  SessionInfo,
  SessionSnapshot,
  StreamFn,
  Uji,
} from "@uji-ai/core";
import { definePlugin, inlinePlugin, type LoadedPlugin, type Plugin } from "@uji-ai/core/plugins";
import { SqliteSessionRepo } from "@uji-ai/core/store";
import { agentById, type Agent, type AgentDraft, type AgentId } from "../agents.ts";
import type {
  AuthStatus,
  ConversationSummary,
  DesktopModelOption,
  LivePart,
  LiveSnapshot,
  RuntimeSettings,
  RuntimeSettingsChange,
  UjiDesktopEvent,
  UjiSnapshot,
} from "../desktop-api.ts";
import { AgentProfileRepo } from "./agent-profile-repo.ts";
import { DesktopSettingsRepo } from "./desktop-settings-repo.ts";

const AGENT_PLUGIN_ID = "demo-agent-profiles";
const MODEL_SETTING = "model-key";
const THINKING_SETTING = "thinking-level";
const SEEDED_AGENTS_SETTING = "initial-agents-seeded";

export interface UjiHostDependencies {
  authStatus(): Promise<AuthStatus>;
  login(emit: (event: UjiDesktopEvent) => void): Promise<void>;
  logout?(): Promise<void>;
  streamFn: StreamFn;
  model: Model<Api>;
  models?: readonly Model<Api>[];
  initialAgents?: readonly AgentDraft[];
  thinkingLevel?: ModelThinkingLevel;
}

interface StoredConversation {
  agentId: AgentId;
  info: SessionInfo;
}

interface SessionRuntime {
  readonly agentId: AgentId;
  readonly id: SessionId;
  readonly live: Map<string, LivePart>;
  running: boolean;
  seq?: Seq;
  stopping: boolean;
  watch?: {
    readonly stop: AbortController;
    readonly ready: Promise<void>;
    done: Promise<void>;
  };
}

export class UjiHost {
  private readonly sessions: SqliteSessionRepo;
  private readonly emit: (event: UjiDesktopEvent) => void;
  private readonly dependencies: UjiHostDependencies;
  private readonly profileRepo: AgentProfileRepo;
  private readonly settingsRepo: DesktopSettingsRepo;
  private readonly models: readonly Model<Api>[];
  private readonly catalog: ModelCatalog;
  private profiles: Agent[] = [];
  private profilesLoaded = false;
  private activeAgentId: AgentId | null = null;
  private activeSessionId: SessionId | null = null;
  private auth: AuthStatus = { signedIn: false, label: "Not connected" };
  private initialization: Promise<void> | undefined;
  private model: Model<Api>;
  private thinkingLevel: ModelThinkingLevel;
  private readonly runtimes = new Map<SessionId, SessionRuntime>();
  private sdk: Uji | undefined;
  private opening: Promise<Uji> | undefined;
  private runnerAttachment: Disposer | undefined;
  private snapshotEmissions: Promise<void> = Promise.resolve();
  private closed = false;
  private pluginRevision = 0;

  constructor(
    databasePath: string,
    emit: (event: UjiDesktopEvent) => void,
    dependencies: UjiHostDependencies,
  ) {
    this.sessions = new SqliteSessionRepo(databasePath);
    this.profileRepo = new AgentProfileRepo(databasePath);
    this.settingsRepo = new DesktopSettingsRepo(databasePath);
    this.emit = emit;
    this.dependencies = dependencies;
    this.models = uniqueModels([dependencies.model, ...(dependencies.models ?? [])]);
    this.catalog = modelCatalog(this.models);
    this.model = dependencies.model;
    this.thinkingLevel = supportedThinkingLevel(this.model, dependencies.thinkingLevel ?? "off");
    this.loadRuntimeSettings();
  }

  async initialize(): Promise<UjiSnapshot> {
    this.initialization ??= this.initializeOnce();
    await this.initialization;
    return this.snapshot();
  }

  async login(): Promise<UjiSnapshot> {
    this.loadProfiles();
    await this.dependencies.login(this.emit);
    this.auth = await this.dependencies.authStatus();
    await this.restoreRuntimes();
    if (this.auth.signedIn) this.attachRunner(await this.ensureSdk());
    return this.emitSnapshot();
  }

  async logout(): Promise<UjiSnapshot> {
    await this.assertAllIdle();
    if (this.dependencies.logout === undefined) throw new Error("Sign out is unavailable");
    this.detachRunner();
    await this.stopAllRuntimes();
    await this.dependencies.logout();
    this.auth = await this.dependencies.authStatus();
    return this.emitSnapshot();
  }

  async send(message: string): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.auth = await this.dependencies.authStatus();
    if (!this.auth.signedIn) throw new Error("Sign in with ChatGPT first");
    const agentId = this.activeAgentId;
    if (agentId === null) throw new Error("Create an agent first");

    let runtime = this.activeRuntime();
    if (runtime === undefined) {
      runtime = await this.createRuntime(agentId);
      this.activeSessionId = runtime.id;
    }
    const sdk = await this.ensureRuntimeReady(runtime);
    const info = await sdk.sessions.get({ sessionId: runtime.id });
    if (info?.name === undefined) {
      await sdk.sessions.rename({ sessionId: runtime.id, name: conversationTitle(message) });
    }
    await sdk.messages.send({ sessionId: runtime.id, content: message });
    return this.emitSnapshot();
  }

  async cancelQueued(entryId: string): Promise<UjiSnapshot> {
    const runtime = this.activeRuntime();
    if (runtime === undefined) throw new Error("No agent session is open");
    const cancelled = await (
      await this.ensureSdk()
    ).messages.cancel({
      sessionId: runtime.id,
      entryId,
    });
    if (cancelled.kind !== "cancelled") {
      throw new Error(
        cancelled.kind === "already_consumed"
          ? "Queued message was already consumed"
          : "Queued message was not found",
      );
    }
    return this.emitSnapshot();
  }

  async abort(): Promise<void> {
    const runtime = this.activeRuntime();
    if (runtime === undefined) return;
    await (await this.ensureSdk()).runs.abort({ sessionId: runtime.id });
  }

  async newChat(agentId?: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    const targetId = agentId ?? this.activeAgentId;
    if (targetId === null) throw new Error("Create an agent first");
    if (agentById(targetId, this.profiles) === undefined) {
      throw new Error(`Unknown agent: ${targetId}`);
    }

    // An untouched chat is reused instead of piling up empty sessions in the database.
    const current = this.activeRuntime();
    const reusable =
      current?.agentId === targetId && (await this.isUnusedSession(current.id))
        ? current
        : undefined;
    const runtime = reusable ?? (await this.createRuntime(targetId));
    this.activeAgentId = targetId;
    this.activeSessionId = runtime.id;
    this.auth = await this.dependencies.authStatus();
    if (this.auth.signedIn) await this.ensureRuntimeReady(runtime);
    return this.emitSnapshot();
  }

  async selectAgent(agentId: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    if (agentById(agentId, this.profiles) === undefined) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    if (agentId === this.activeAgentId) return this.snapshot();

    const latest = (await this.listConversations()).find(
      (conversation) => conversation.agentId === agentId,
    );
    this.activeAgentId = agentId;
    this.activeSessionId = latest?.info.sessionId ?? null;
    if (latest !== undefined) {
      const runtime = await this.ensureRuntime(latest.info.sessionId, agentId);
      this.auth = await this.dependencies.authStatus();
      if (this.auth.signedIn) await this.ensureRuntimeReady(runtime);
    }
    return this.emitSnapshot();
  }

  async selectConversation(sessionId: SessionId): Promise<UjiSnapshot> {
    this.loadProfiles();
    if (sessionId === this.activeSessionId) return this.snapshot();
    const conversation = (await this.listConversations()).find(
      (candidate) => candidate.info.sessionId === sessionId,
    );
    if (conversation === undefined) throw new Error(`Unknown conversation: ${sessionId}`);

    const runtime = await this.ensureRuntime(sessionId, conversation.agentId);
    this.activeAgentId = conversation.agentId;
    this.activeSessionId = sessionId;
    this.auth = await this.dependencies.authStatus();
    if (this.auth.signedIn) await this.ensureRuntimeReady(runtime);
    return this.emitSnapshot();
  }

  async renameConversation(sessionId: SessionId, name: string): Promise<UjiSnapshot> {
    const normalized = name.replaceAll(/\s+/g, " ").trim();
    if (normalized === "") throw new Error("Conversation title is required");
    await (await this.ensureSdk()).sessions.rename({ sessionId, name: normalized });
    return this.emitSnapshot();
  }

  async createAgent(draft: AgentDraft): Promise<UjiSnapshot> {
    this.loadProfiles();
    const agent: Agent = { id: localId("agent"), ...draft };
    this.profileRepo.insert(agent);
    this.profiles.push(agent);
    await this.refreshAgentPlugin();
    this.activeAgentId = agent.id;
    this.activeSessionId = null;
    return this.emitSnapshot();
  }

  async updateAgent(agentId: AgentId, changes: AgentDraft): Promise<UjiSnapshot> {
    this.loadProfiles();
    await this.assertAgentIdle(agentId);
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    const current = this.profiles[index];
    if (current === undefined) throw new Error(`Unknown agent: ${agentId}`);
    const updated: Agent = { id: current.id, ...changes };
    this.profileRepo.update(updated);
    this.profiles[index] = updated;
    await this.refreshAgentPlugin();
    return this.emitSnapshot();
  }

  async deleteAgent(agentId: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    await this.assertAgentIdle(agentId);
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    if (index < 0) throw new Error(`Unknown agent: ${agentId}`);

    await this.closeAgentRuntimes(agentId);
    this.profileRepo.delete(agentId);
    this.profiles.splice(index, 1);
    await this.refreshAgentPlugin();
    if (agentId === this.activeAgentId) {
      this.activeAgentId = this.profiles[0]?.id ?? null;
      const latest =
        this.activeAgentId === null
          ? undefined
          : (await this.listConversations()).find(
              (conversation) => conversation.agentId === this.activeAgentId,
            );
      this.activeSessionId = latest?.info.sessionId ?? null;
      if (latest !== undefined) {
        const runtime = await this.ensureRuntime(latest.info.sessionId, latest.agentId);
        this.auth = await this.dependencies.authStatus();
        if (this.auth.signedIn) await this.ensureRuntimeReady(runtime);
      }
    }
    return this.emitSnapshot();
  }

  async updateRuntimeSettings(change: RuntimeSettingsChange): Promise<UjiSnapshot> {
    await this.assertAllIdle();
    const previousModel = this.model;
    const previousThinkingLevel = this.thinkingLevel;
    let nextModel = previousModel;
    let nextThinkingLevel = previousThinkingLevel;
    if (change.kind === "model") {
      const selected = this.models.find((model) => modelKey(model) === change.modelKey);
      if (selected === undefined) throw new Error(`Unknown model: ${change.modelKey}`);
      nextModel = selected;
      nextThinkingLevel = supportedThinkingLevel(selected, nextThinkingLevel);
    } else {
      nextThinkingLevel = supportedThinkingLevel(nextModel, change.thinkingLevel, true);
    }
    if (nextModel === previousModel && nextThinkingLevel === previousThinkingLevel) {
      return this.snapshot();
    }

    const sdk = await this.ensureSdk();
    const { items } = await sdk.sessions.list();
    for (const info of items) {
      const agentId = info.config.agent ?? null;
      if (agentId === null || agentById(agentId, this.profiles) === undefined) continue;
      const outcome = await sdk.sessions.configure({
        sessionId: info.sessionId,
        ...(nextModel === previousModel
          ? {}
          : { model: { provider: nextModel.provider, id: nextModel.id } }),
        ...(nextThinkingLevel === previousThinkingLevel
          ? {}
          : { thinkingLevel: nextThinkingLevel }),
      });
      if (outcome.kind === "unknown_model") throw new Error(`Unknown model: ${nextModel.id}`);
    }
    this.model = nextModel;
    this.thinkingLevel = nextThinkingLevel;
    this.settingsRepo.set(MODEL_SETTING, modelKey(this.model));
    this.settingsRepo.set(THINKING_SETTING, this.thinkingLevel);
    return this.emitSnapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    this.detachRunner();
    await this.closeAllRuntimes().catch((error: unknown) => errors.push(error));
    await this.snapshotEmissions.catch((error: unknown) => errors.push(error));
    if (this.opening !== undefined) {
      await this.opening.catch((error: unknown) => errors.push(error));
    }
    const sdk = this.sdk;
    this.sdk = undefined;
    this.opening = undefined;
    await sdk?.close().catch((error: unknown) => errors.push(error));
    await this.sessions.close().catch((error: unknown) => errors.push(error));
    try {
      this.profileRepo.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.settingsRepo.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close desktop host");
  }

  private async initializeOnce(): Promise<void> {
    this.loadProfiles();
    await this.ensureSdk();
    const latest = (await this.listConversations())[0];
    if (latest !== undefined) {
      this.activeAgentId = latest.agentId;
      this.activeSessionId = latest.info.sessionId;
    } else {
      this.activeAgentId = this.profiles[0]?.id ?? null;
    }
    this.auth = await this.dependencies.authStatus();
    await this.restoreRuntimes();
    if (this.auth.signedIn) this.attachRunner(await this.ensureSdk());
  }

  private async assertAllIdle(): Promise<void> {
    if (await this.hasOwedWork()) {
      throw new Error("Wait for running responses or stop them before changing this setting");
    }
  }

  private async assertAgentIdle(agentId: AgentId): Promise<void> {
    if (await this.hasOwedWork(agentId)) {
      throw new Error("Wait for this assistant's responses or stop them before changing it");
    }
  }

  private async hasOwedWork(agentId?: AgentId): Promise<boolean> {
    const sdk = await this.ensureSdk();
    const { items } = await sdk.sessions.list();
    for (const info of items) {
      if (agentId !== undefined && info.config.agent !== agentId) {
        continue;
      }
      if (await this.sessionHasOwedWork(info)) return true;
    }
    return false;
  }

  private async sessionHasOwedWork(info: SessionInfo): Promise<boolean> {
    const session = await this.sessions.open(info.sessionId);
    try {
      const log = await session.getLog();
      const operationHeads = new Map<string, string>();
      const lastOperation = new Map<string, number>();
      const lastPlacement = new Map<string, number>();
      for (const item of log) {
        if (item.kind === "record" && item.record.type === "operation_started") {
          operationHeads.set(item.record.id, item.record.head);
          lastOperation.set(item.record.head, item.seq);
        } else if (item.kind === "record" && item.record.type === "operation_finished") {
          const head = operationHeads.get(item.record.runId);
          if (head !== undefined) lastOperation.set(head, item.seq);
        } else if (
          item.kind === "entry" &&
          item.entry.type === "message" &&
          item.entry.message.role === "user"
        ) {
          lastPlacement.set(item.head, item.seq);
        }
      }
      for (const head of info.heads) {
        if ((await session.getLiveClaim(head.name)) !== undefined) return true;
        if ((await session.findOpenOperations(head.name))[0] !== undefined) return true;
        if ((lastPlacement.get(head.name) ?? -1) > (lastOperation.get(head.name) ?? -1)) {
          return true;
        }
      }
      return false;
    } finally {
      await session.close();
    }
  }

  private activeRuntime(): SessionRuntime | undefined {
    return this.activeSessionId === null ? undefined : this.runtimes.get(this.activeSessionId);
  }

  private async restoreRuntimes(): Promise<void> {
    const sdk = await this.ensureSdk();
    const { items } = await sdk.sessions.list();
    for (const info of items) {
      const agentId = info.config.agent ?? null;
      if (agentId === null || agentById(agentId, this.profiles) === undefined) continue;
      const running = sessionHasRun(info);
      const shouldOpen = info.sessionId === this.activeSessionId || running;
      const existing = this.runtimes.get(info.sessionId);
      if (existing !== undefined) {
        existing.running ||= running;
        if (this.auth.signedIn && shouldOpen) await this.ensureRuntimeObserved(existing, sdk);
        continue;
      }
      if (!shouldOpen) continue;
      const runtime = createSessionRuntime(info.sessionId, agentId, running);
      this.runtimes.set(info.sessionId, runtime);
      if (this.auth.signedIn) await this.ensureRuntimeObserved(runtime, sdk);
    }
  }

  private async createRuntime(agentId: AgentId): Promise<SessionRuntime> {
    if (agentById(agentId, this.profiles) === undefined) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const sdk = await this.ensureSdk();
    const { sessionId } = await sdk.sessions.create();
    const configured = await sdk.sessions.configure({
      sessionId,
      agent: agentId,
      model: { provider: this.model.provider, id: this.model.id },
      thinkingLevel: this.thinkingLevel,
    });
    if (configured.kind === "unknown_model") throw new Error(`Unknown model: ${this.model.id}`);
    if (configured.kind === "unknown_agent") throw new Error(`Unknown agent: ${agentId}`);
    const runtime = createSessionRuntime(sessionId, agentId, false);
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  private async ensureRuntime(
    sessionId: SessionId,
    expectedAgentId: AgentId,
  ): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) {
      if (existing.agentId !== expectedAgentId) {
        throw new Error(`Conversation ${sessionId} belongs to another agent`);
      }
      return existing;
    }

    const sdk = await this.ensureSdk();
    const info = await sdk.sessions.get({ sessionId });
    if (info === undefined) throw new Error(`Unknown conversation: ${sessionId}`);
    const agentId = info.config.agent ?? null;
    if (agentId !== expectedAgentId) {
      throw new Error(`Conversation ${sessionId} belongs to another agent`);
    }
    const runtime = createSessionRuntime(sessionId, agentId, sessionHasRun(info));
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  private async ensureSdk(): Promise<Uji> {
    if (this.sdk !== undefined) return this.sdk;
    if (this.closed) throw new Error("Desktop host is closed");
    this.opening ??= createUji({
      store: this.sessions,
      streamFn: this.dependencies.streamFn,
      models: this.catalog,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      plugins: this.loadedPlugins(),
      env: { cwd: process.cwd() },
    });
    const opening = this.opening;
    try {
      const sdk = await opening;
      this.sdk = sdk;
      return sdk;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }

  private loadedPlugins(): readonly LoadedPlugin[] {
    return [
      inlinePlugin(agentProfilesPlugin(this.profiles), {
        version: `profiles-${String(this.pluginRevision)}`,
      }),
    ];
  }

  private async refreshAgentPlugin(): Promise<void> {
    this.pluginRevision += 1;
    await this.sdk?.setPlugins(this.loadedPlugins());
  }

  private async ensureRuntimeReady(runtime: SessionRuntime): Promise<Uji> {
    const sdk = await this.ensureRuntimeObserved(runtime);
    this.attachRunner(sdk);
    return sdk;
  }

  private async ensureRuntimeObserved(runtime: SessionRuntime, existingSdk?: Uji): Promise<Uji> {
    if (runtime.stopping) throw new Error(`Conversation ${runtime.id} is closing`);
    const agent = agentById(runtime.agentId, this.profiles);
    if (agent === undefined) throw new Error(`Unknown agent: ${runtime.agentId}`);
    const sdk = existingSdk ?? (await this.ensureSdk());
    const watch = runtime.watch ?? this.startRuntimeWatch(runtime, sdk);
    await watch.ready;
    if (runtime.stopping || runtime.watch !== watch) {
      throw new Error(`Conversation ${runtime.id} is closing`);
    }
    return sdk;
  }

  private startRuntimeWatch(
    runtime: SessionRuntime,
    sdk: Uji,
  ): NonNullable<SessionRuntime["watch"]> {
    const stop = new AbortController();
    let resolveReady: () => void = () => undefined;
    let rejectReady: (reason: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const watch: NonNullable<SessionRuntime["watch"]> = {
      stop,
      ready,
      done: Promise.resolve(),
    };
    runtime.watch = watch;
    watch.done = this.consumeRuntimeWatch(runtime, sdk, watch, resolveReady, rejectReady);
    return watch;
  }

  private async consumeRuntimeWatch(
    runtime: SessionRuntime,
    sdk: Uji,
    watch: NonNullable<SessionRuntime["watch"]>,
    resolveReady: () => void,
    rejectReady: (reason: unknown) => void,
  ): Promise<void> {
    let ready = false;
    try {
      const snapshot = await requireSessionSnapshot(sdk, runtime.id);
      runtime.running = sessionHasRun(snapshot.session);
      runtime.seq = snapshot.seq;
      while (!watch.stop.signal.aborted) {
        const iterator = sdk
          .watch({ sessionId: runtime.id, afterSeq: runtime.seq, signal: watch.stop.signal })
          [Symbol.asyncIterator]();
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done === true) {
              if (watch.stop.signal.aborted) return;
              throw new Error(`Watch ended for ${runtime.id}`);
            }
            if (watch.stop.signal.aborted) return;
            this.forward(runtime, next.value);
            if (!ready && next.value.kind === "synced") {
              ready = true;
              resolveReady();
            }
          }
        } catch (error) {
          if (watch.stop.signal.aborted) return;
          if (!ready) throw error;
          this.emit({ type: "error", sessionId: runtime.id, message: errorMessage(error) });
          await waitForWatchRetry(watch.stop.signal);
        } finally {
          await iterator.return?.().catch(() => undefined);
        }
      }
    } catch (error) {
      if (!ready) rejectReady(error);
      if (ready && !watch.stop.signal.aborted) {
        this.emit({ type: "error", sessionId: runtime.id, message: errorMessage(error) });
      }
    } finally {
      if (!ready) rejectReady(new Error(`Watch stopped before syncing ${runtime.id}`));
      if (runtime.watch === watch) runtime.watch = undefined;
    }
  }

  private async stopRuntime(runtime: SessionRuntime): Promise<void> {
    runtime.stopping = true;
    const watch = runtime.watch;
    watch?.stop.abort();
    try {
      await watch?.done;
    } finally {
      if (runtime.watch === watch) runtime.watch = undefined;
      runtime.running = false;
      runtime.stopping = false;
      resetLive(runtime);
    }
  }

  private attachRunner(sdk: Uji): void {
    this.runnerAttachment ??= sdk.attach();
  }

  private detachRunner(): void {
    this.runnerAttachment?.();
    this.runnerAttachment = undefined;
  }

  private async stopRuntimeGroup(runtimes: readonly SessionRuntime[]): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of runtimes) {
      await this.stopRuntime(runtime).catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to stop agent sessions");
  }

  private async stopAllRuntimes(): Promise<void> {
    await this.stopRuntimeGroup([...this.runtimes.values()]);
  }

  private async closeAgentRuntimes(agentId: AgentId): Promise<void> {
    await this.closeRuntimeGroup(
      [...this.runtimes.values()].filter((runtime) => runtime.agentId === agentId),
    );
  }

  private async closeAllRuntimes(): Promise<void> {
    await this.closeRuntimeGroup([...this.runtimes.values()]);
  }

  private async closeRuntimeGroup(runtimes: readonly SessionRuntime[]): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of runtimes) {
      await this.closeRuntime(runtime).catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close agent sessions");
  }

  private async closeRuntime(runtime: SessionRuntime): Promise<void> {
    await this.stopRuntime(runtime);
    if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id);
  }

  private forward(runtime: SessionRuntime, event: SessionEvent): void {
    const sessionId = runtime.id;
    if ("seq" in event) runtime.seq = Math.max(runtime.seq ?? event.seq, event.seq);
    this.emit({ type: "session", event, sessionId });
    switch (event.kind) {
      case "synced":
      case "claim":
      case "plugins_changed":
        return;
      case "run_started":
        resetLive(runtime);
        runtime.running = true;
        return;
      case "run_finished":
        resetLive(runtime);
        runtime.running = false;
        this.refreshAfterSessionEvent(sessionId);
        return;
      case "text_delta": {
        const key = livePartKey("text", event.entryId, event.contentIndex);
        const current = runtime.live.get(key);
        runtime.live.set(key, {
          kind: "text",
          contentIndex: event.contentIndex,
          entryId: event.entryId,
          text: (current?.kind === "text" ? current.text : "") + event.delta,
        });
        return;
      }
      case "reasoning_delta": {
        const key = livePartKey("thinking", event.entryId, event.contentIndex);
        const current = runtime.live.get(key);
        runtime.live.set(key, {
          kind: "thinking",
          contentIndex: event.contentIndex,
          entryId: event.entryId,
          text: (current?.kind === "thinking" ? current.text : "") + event.delta,
        });
        return;
      }
      case "tool_progress": {
        const tool: LivePart = {
          kind: "tool",
          callId: event.callId,
          entryId: event.entryId,
          progress: event.progress,
        };
        runtime.live.set(livePartKey("tool", event.callId), tool);
        return;
      }
      case "message":
        dropLiveEntry(runtime, event.entryId);
        this.refreshAfterSessionEvent(sessionId);
        return;
      case "queued":
      case "queue_consumed":
      case "queue_cancelled":
      case "compaction":
      case "name_changed":
      case "head_moved":
        this.refreshAfterSessionEvent(sessionId);
        return;
      case "retry_scheduled":
      case "retry_started":
      case "compacting":
        if (!runtime.running) {
          runtime.running = true;
        }
        return;
      case "diagnostic":
        if (event.level === "error") {
          this.emit({ type: "error", sessionId, message: event.message });
        }
        return;
      case "run_waiting":
        // Parked waiting for input; the composer answers it.
        if (runtime.running) {
          runtime.running = false;
        }
        this.refreshAfterSessionEvent(sessionId);
        return;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  }

  private refreshAfterSessionEvent(sessionId: SessionId): void {
    void this.emitSnapshot().catch((error: unknown) => {
      this.emit({ type: "error", sessionId, message: errorMessage(error) });
    });
  }

  private async emitSnapshot(): Promise<UjiSnapshot> {
    const emission = this.snapshotEmissions.then(async () => {
      const snapshot = await this.snapshot();
      this.emit({ type: "snapshot", snapshot });
      return snapshot;
    });
    this.snapshotEmissions = emission.then(
      () => undefined,
      () => undefined,
    );
    return emission;
  }

  private async snapshot(): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.auth = await this.dependencies.authStatus();
    return this.buildSnapshot();
  }

  private async buildSnapshot(): Promise<UjiSnapshot> {
    for (;;) {
      const activeAgentId = this.activeAgentId;
      const activeSessionId = this.activeSessionId;
      const runtime = activeSessionId === null ? undefined : this.runtimes.get(activeSessionId);
      const sessionSnapshot =
        runtime === undefined
          ? undefined
          : await requireSessionSnapshot(await this.ensureSdk(), runtime.id);
      const conversations: ConversationSummary[] = (await this.listConversations()).map(
        ({ agentId, info }) => ({
          agentId,
          id: info.sessionId,
          name: info.name,
          preview: info.preview,
          lastActivity: info.lastActivityAt,
          running: this.runtimes.get(info.sessionId)?.running === true || sessionHasRun(info),
        }),
      );
      if (activeAgentId !== this.activeAgentId || activeSessionId !== this.activeSessionId) {
        continue;
      }
      const running =
        runtime !== undefined &&
        (runtime.running ||
          (sessionSnapshot === undefined ? false : sessionHasRun(sessionSnapshot.session)));
      return {
        activeAgentId,
        activeSessionId,
        agents: this.profiles.map((agent) => ({ ...agent })),
        auth: this.auth,
        context: sessionSnapshot?.context ?? null,
        conversations,
        live: liveSnapshot(runtime),
        messages: sessionSnapshot?.transcript ?? [],
        pending: sessionSnapshot?.pending ?? [],
        running,
        runtime: this.runtimeSettings(),
      };
    }
  }

  private runtimeSettings(): RuntimeSettings {
    return {
      modelKey: modelKey(this.model),
      models: this.models.map(modelOption),
      thinkingLevel: this.thinkingLevel,
    };
  }

  private async listConversations(): Promise<StoredConversation[]> {
    const { items } = await (await this.ensureSdk()).sessions.list();
    const conversations: StoredConversation[] = [];
    for (const info of items) {
      const agentId = info.config.agent ?? null;
      if (agentId === null || agentById(agentId, this.profiles) === undefined) continue;
      // A chat the user never wrote in is not a chat yet, so it stays out of the directory.
      if (info.preview === undefined && info.name === undefined) continue;
      conversations.push({ agentId, info });
    }
    return conversations.toSorted((a, b) => b.info.lastActivityAt - a.info.lastActivityAt);
  }

  private async isUnusedSession(id: SessionId): Promise<boolean> {
    const snapshot = await requireSessionSnapshot(await this.ensureSdk(), id);
    if (snapshot.session.name !== undefined) return false;
    return !snapshot.transcript.some(
      (turn) => turn.kind === "turn" && turn.parts.some((part) => part.kind === "user"),
    );
  }

  private loadProfiles(): void {
    if (this.profilesLoaded) return;
    this.profilesLoaded = true;
    this.profiles = this.profileRepo.list();
    if (this.profiles.length > 0 || this.settingsRepo.get(SEEDED_AGENTS_SETTING) === "1") return;
    for (const draft of this.dependencies.initialAgents ?? []) {
      const agent: Agent = { id: localId("agent"), ...draft };
      this.profileRepo.insert(agent);
      this.profiles.push(agent);
    }
    this.settingsRepo.set(SEEDED_AGENTS_SETTING, "1");
  }

  private loadRuntimeSettings(): void {
    const storedModel = this.settingsRepo.get(MODEL_SETTING);
    const selected = this.models.find((model) => modelKey(model) === storedModel);
    if (selected !== undefined) this.model = selected;
    const storedThinking = this.settingsRepo.get(THINKING_SETTING);
    if (isModelThinkingLevel(storedThinking)) {
      this.thinkingLevel = supportedThinkingLevel(this.model, storedThinking);
    } else {
      this.thinkingLevel = supportedThinkingLevel(this.model, this.thinkingLevel);
    }
  }
}

function createSessionRuntime(id: SessionId, agentId: AgentId, running: boolean): SessionRuntime {
  return {
    agentId,
    id,
    live: new Map(),
    running,
    stopping: false,
  };
}

function liveSnapshot(runtime: SessionRuntime | undefined): LiveSnapshot {
  return { parts: runtime === undefined ? [] : [...runtime.live.values()] };
}

function resetLive(runtime: SessionRuntime): void {
  runtime.live.clear();
}

function dropLiveEntry(runtime: SessionRuntime, entryId: string): void {
  for (const [key, part] of runtime.live) {
    if (part.entryId === entryId) runtime.live.delete(key);
  }
}

function livePartKey(kind: LivePart["kind"], id: string, contentIndex?: number): string {
  return `${kind}:${id}:${contentIndex === undefined ? "" : String(contentIndex)}`;
}

function waitForWatchRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function agentProfilesPlugin(profiles: readonly Agent[]): Plugin {
  const agents = profiles.map((agent) => ({
    id: agent.id,
    mode: "primary" as const,
    system: agent.instructions,
    ...(agent.role === "" ? {} : { description: agent.role }),
  }));
  return definePlugin({
    id: AGENT_PLUGIN_ID,
    session(api) {
      api.agents.add((draft) => {
        for (const agent of agents) draft.set(agent.id, agent);
      });
    },
  });
}

function modelCatalog(models: readonly Model<Api>[]): ModelCatalog {
  return {
    getModels: (provider) =>
      provider === undefined ? models : models.filter((model) => model.provider === provider),
    getModel: (provider, id) =>
      models.find((model) => model.provider === provider && model.id === id),
  };
}

async function requireSessionSnapshot(sdk: Uji, id: SessionId): Promise<SessionSnapshot> {
  const snapshot = await sdk.sessions.snapshot({ sessionId: id });
  if (snapshot === undefined) throw new Error(`Unknown conversation: ${id}`);
  return snapshot;
}

function sessionHasRun(info: SessionInfo): boolean {
  return info.heads.some((head) => head.run?.kind === "live" || head.run?.kind === "orphaned");
}

function localId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function conversationTitle(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47).trimEnd()}…`;
}

function uniqueModels(models: readonly Model<Api>[]): readonly Model<Api>[] {
  return [...new Map(models.map((model) => [modelKey(model), model])).values()];
}

function modelKey(model: Pick<Model<Api>, "id" | "provider">): string {
  return `${model.provider}/${model.id}`;
}

function modelOption(model: Model<Api>): DesktopModelOption {
  return {
    contextWindow: model.contextWindow,
    id: model.id,
    key: modelKey(model),
    maxTokens: model.maxTokens,
    name: model.name,
    provider: model.provider,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model),
  };
}

function supportedThinkingLevel(
  model: Model<Api>,
  requested: ModelThinkingLevel,
  strict = false,
): ModelThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;
  if (strict) throw new Error(`${requested} reasoning is unavailable for ${model.name}`);
  return supported.includes("medium") ? "medium" : (supported[0] ?? "off");
}

function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return (
    typeof value === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
