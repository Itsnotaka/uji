import { getSupportedThinkingLevels } from "@uji-ai/ai/models";
import type { Api, Model, ModelThinkingLevel } from "@uji-ai/ai/types";
import {
  projectContextStatus,
  sessionDirectoryEntryFromLog,
  toJsonValue,
  transcriptFromEntries,
  type SessionDirectoryEntry,
} from "@uji-ai/core";
import { AgentHarness, type HarnessEvent } from "@uji-ai/core/harness";
import { systemPromptPlugin } from "@uji-ai/core/plugins/system-prompt";
import { inlinePlugin } from "@uji-ai/core/plugins/types";
import { SqliteSessionRepo } from "@uji-ai/core/session/sqlite";
import { newId, type SessionStorage } from "@uji-ai/core/session/types";
import type { StreamFn } from "@uji-ai/core/types";
import { agentById, type Agent, type AgentDraft, type AgentId } from "../agents.ts";
import type {
  AuthStatus,
  ConversationSummary,
  DesktopModelOption,
  LiveSnapshot,
  LiveToolEvent,
  RuntimeSettings,
  RuntimeSettingsChange,
  UjiDesktopEvent,
  UjiSnapshot,
} from "../desktop-api.ts";
import { AgentProfileRepo } from "./agent-profile-repo.ts";
import { DesktopSettingsRepo } from "./desktop-settings-repo.ts";

const AGENT_ENTRY_TYPE = "uji.demo.agent";
const MODEL_SETTING = "model-key";
const THINKING_SETTING = "thinking-level";
const SEEDED_AGENTS_SETTING = "initial-agents-seeded";

export interface UjiHostDependencies {
  authStatus(): Promise<AuthStatus>;
  login(emit: (event: UjiDesktopEvent) => void): Promise<void>;
  logout?(): Promise<void>;
  createStreamFn(agentId: AgentId): StreamFn;
  model: Model<Api>;
  models?: readonly Model<Api>[];
  initialAgents?: readonly AgentDraft[];
  thinkingLevel?: ModelThinkingLevel;
}

interface StoredConversation {
  agentId: AgentId;
  directory: SessionDirectoryEntry;
}

interface SessionRuntime {
  readonly agentId: AgentId;
  readonly id: string;
  readonly live: {
    streamingText: string;
    thinkingText: string;
    tools: Map<string, LiveToolEvent>;
  };
  readonly session: SessionStorage;
  harness?: AgentHarness;
  opening?: Promise<AgentHarness>;
  unsubscribe?: () => void;
}

export class UjiHost {
  private readonly sessions: SqliteSessionRepo;
  private readonly emit: (event: UjiDesktopEvent) => void;
  private readonly dependencies: UjiHostDependencies;
  private readonly profileRepo: AgentProfileRepo;
  private readonly settingsRepo: DesktopSettingsRepo;
  private readonly models: readonly Model<Api>[];
  private profiles: Agent[] = [];
  private profilesLoaded = false;
  private activeAgentId: AgentId | null = null;
  private activeSessionId: string | null = null;
  private auth: AuthStatus = { signedIn: false, label: "Not connected" };
  private initialization: Promise<void> | undefined;
  private model: Model<Api>;
  private thinkingLevel: ModelThinkingLevel;
  private readonly runtimes = new Map<string, SessionRuntime>();

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
    this.models = uniqueModels(dependencies.models ?? [dependencies.model]);
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
    return this.emitSnapshot();
  }

  async logout(): Promise<UjiSnapshot> {
    this.assertAllIdle();
    if (this.dependencies.logout === undefined) throw new Error("Sign out is unavailable");
    await this.closeAllHarnesses();
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
    if ((await runtime.session.getName()) === undefined) {
      await runtime.session.setName(conversationTitle(message));
    }
    const harness = await this.ensureHarness(runtime);
    const submitted = await harness.submit(message);
    if (!submitted.ok) throw submitted.error;
    return this.emitSnapshot();
  }

  async cancelQueued(entryId: string): Promise<UjiSnapshot> {
    const harness = this.activeRuntime()?.harness;
    if (harness === undefined) throw new Error("No agent session is open");
    const cancelled = await harness.cancelQueued(entryId);
    if (!cancelled.ok) throw cancelled.error;
    return this.emitSnapshot();
  }

  async abort(): Promise<void> {
    const harness = this.activeRuntime()?.harness;
    if (harness?.state.isStreaming !== true) return;
    const result = await harness.abort();
    if (!result.ok) throw result.error;
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
      current?.agentId === targetId && (await isUnusedSession(current.session))
        ? current
        : undefined;
    const runtime = reusable ?? (await this.createRuntime(targetId));
    this.activeAgentId = targetId;
    this.activeSessionId = runtime.id;
    this.auth = await this.dependencies.authStatus();
    if (this.auth.signedIn) await this.ensureHarness(runtime);
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
    this.activeSessionId = latest?.directory.id ?? null;
    if (latest !== undefined) {
      const runtime = await this.ensureRuntime(latest.directory.id, agentId);
      this.auth = await this.dependencies.authStatus();
      if (this.auth.signedIn) await this.ensureHarness(runtime);
    }
    return this.emitSnapshot();
  }

  async selectConversation(sessionId: string): Promise<UjiSnapshot> {
    this.loadProfiles();
    if (sessionId === this.activeSessionId) return this.snapshot();
    const conversation = (await this.listConversations()).find(
      (candidate) => candidate.directory.id === sessionId,
    );
    if (conversation === undefined) throw new Error(`Unknown conversation: ${sessionId}`);

    const runtime = await this.ensureRuntime(sessionId, conversation.agentId);
    this.activeAgentId = conversation.agentId;
    this.activeSessionId = sessionId;
    this.auth = await this.dependencies.authStatus();
    if (this.auth.signedIn) await this.ensureHarness(runtime);
    return this.emitSnapshot();
  }

  async renameConversation(sessionId: string, name: string): Promise<UjiSnapshot> {
    const normalized = name.replaceAll(/\s+/g, " ").trim();
    if (normalized === "") throw new Error("Conversation title is required");
    const runtime = this.runtimes.get(sessionId);
    const session = runtime?.session ?? (await this.sessions.open(sessionId));
    try {
      await session.setName(normalized);
    } finally {
      if (runtime === undefined) await session.close();
    }
    return this.emitSnapshot();
  }

  async createAgent(draft: AgentDraft): Promise<UjiSnapshot> {
    this.loadProfiles();
    const agent: Agent = { id: newId("agent"), ...draft };
    this.profileRepo.insert(agent);
    this.profiles.push(agent);
    this.activeAgentId = agent.id;
    this.activeSessionId = null;
    return this.emitSnapshot();
  }

  async updateAgent(agentId: AgentId, changes: AgentDraft): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertAgentIdle(agentId);
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    const current = this.profiles[index];
    if (current === undefined) throw new Error(`Unknown agent: ${agentId}`);
    const updated: Agent = { id: current.id, ...changes };
    this.profileRepo.update(updated);
    this.profiles[index] = updated;

    await this.closeAgentHarnesses(agentId);
    const runtime = this.activeRuntime();
    this.auth = await this.dependencies.authStatus();
    if (runtime?.agentId === agentId && this.auth.signedIn) await this.ensureHarness(runtime);
    return this.emitSnapshot();
  }

  async deleteAgent(agentId: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertAgentIdle(agentId);
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    if (index < 0) throw new Error(`Unknown agent: ${agentId}`);

    await this.closeAgentRuntimes(agentId);
    this.profileRepo.delete(agentId);
    this.profiles.splice(index, 1);
    if (agentId === this.activeAgentId) {
      this.activeAgentId = this.profiles[0]?.id ?? null;
      const latest =
        this.activeAgentId === null
          ? undefined
          : (await this.listConversations()).find(
              (conversation) => conversation.agentId === this.activeAgentId,
            );
      this.activeSessionId = latest?.directory.id ?? null;
      if (latest !== undefined) {
        const runtime = await this.ensureRuntime(latest.directory.id, latest.agentId);
        this.auth = await this.dependencies.authStatus();
        if (this.auth.signedIn) await this.ensureHarness(runtime);
      }
    }
    return this.emitSnapshot();
  }

  async updateRuntimeSettings(change: RuntimeSettingsChange): Promise<UjiSnapshot> {
    this.assertAllIdle();
    const previousModel = this.model;
    const previousThinkingLevel = this.thinkingLevel;
    if (change.kind === "model") {
      const selected = this.models.find((model) => modelKey(model) === change.modelKey);
      if (selected === undefined) throw new Error(`Unknown model: ${change.modelKey}`);
      this.model = selected;
      this.thinkingLevel = supportedThinkingLevel(selected, this.thinkingLevel);
    } else {
      this.thinkingLevel = supportedThinkingLevel(this.model, change.thinkingLevel, true);
    }
    if (this.model === previousModel && this.thinkingLevel === previousThinkingLevel) {
      return this.snapshot();
    }

    await this.closeAllHarnesses();
    const runtime = this.activeRuntime();
    if (runtime !== undefined) {
      const entries = [];
      if (this.model !== previousModel) {
        entries.push({ type: "model_change" as const, id: newId("e"), modelId: this.model.id });
      }
      if (this.thinkingLevel !== previousThinkingLevel) {
        entries.push({
          type: "thinking_level_change" as const,
          id: newId("e"),
          thinkingLevel: this.thinkingLevel,
        });
      }
      await runtime.session.appendEntries(entries, "main");
    }
    this.settingsRepo.set(MODEL_SETTING, modelKey(this.model));
    this.settingsRepo.set(THINKING_SETTING, this.thinkingLevel);
    this.auth = await this.dependencies.authStatus();
    if (runtime !== undefined && this.auth.signedIn) await this.ensureHarness(runtime);
    return this.emitSnapshot();
  }

  async close(): Promise<void> {
    await this.closeAllRuntimes();
    await this.sessions.close();
    this.profileRepo.close();
    this.settingsRepo.close();
  }

  private async initializeOnce(): Promise<void> {
    this.loadProfiles();
    const latest = (await this.listConversations())[0];
    if (latest !== undefined) {
      this.activeAgentId = latest.agentId;
      this.activeSessionId = latest.directory.id;
    } else {
      this.activeAgentId = this.profiles[0]?.id ?? null;
    }
    this.auth = await this.dependencies.authStatus();
    await this.restoreRuntimes();
  }

  private assertAllIdle(): void {
    if ([...this.runtimes.values()].some((runtime) => runtime.harness?.state.isBusy === true)) {
      throw new Error("Wait for running responses or stop them before changing this setting");
    }
  }

  private assertAgentIdle(agentId: AgentId): void {
    if (
      [...this.runtimes.values()].some(
        (runtime) => runtime.agentId === agentId && runtime.harness?.state.isBusy === true,
      )
    ) {
      throw new Error("Wait for this assistant's responses or stop them before changing it");
    }
  }

  private activeRuntime(): SessionRuntime | undefined {
    return this.activeSessionId === null ? undefined : this.runtimes.get(this.activeSessionId);
  }

  private async restoreRuntimes(): Promise<void> {
    const metadata = await this.sessions.list();
    for (const item of metadata) {
      const existing = this.runtimes.get(item.id);
      if (existing !== undefined) {
        if (this.auth.signedIn && existing.harness === undefined) {
          const open = await existing.session.findOpenOperations("main");
          if (item.id === this.activeSessionId || open.length > 0) {
            await this.ensureHarness(existing);
          }
        }
        continue;
      }

      const session = await this.sessions.open(item.id);
      let runtime: SessionRuntime | undefined;
      try {
        const agentId = agentIdFrom(await session.getBranch("main"));
        if (agentId === null || agentById(agentId, this.profiles) === undefined) {
          await session.close();
          continue;
        }
        const open = await session.findOpenOperations("main");
        if (item.id !== this.activeSessionId && open.length === 0) {
          await session.close();
          continue;
        }
        runtime = createSessionRuntime(item.id, agentId, session);
        this.runtimes.set(item.id, runtime);
        if (this.auth.signedIn) await this.ensureHarness(runtime);
      } catch (error) {
        if (runtime === undefined) {
          await session.close().catch(() => undefined);
        } else {
          await this.closeRuntime(runtime).catch(() => undefined);
        }
        throw error;
      }
    }
  }

  private async createRuntime(agentId: AgentId): Promise<SessionRuntime> {
    const session = await this.sessions.create();
    const id = (await session.getMetadata()).id;
    try {
      await session.appendEntry(
        {
          type: "custom",
          id: newId("e"),
          customType: AGENT_ENTRY_TYPE,
          data: { agentId },
        },
        "main",
      );
    } catch (error) {
      await session.close();
      throw error;
    }
    const runtime = createSessionRuntime(id, agentId, session);
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private async ensureRuntime(
    sessionId: string,
    expectedAgentId: AgentId,
  ): Promise<SessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) {
      if (existing.agentId !== expectedAgentId) {
        throw new Error(`Conversation ${sessionId} belongs to another agent`);
      }
      return existing;
    }

    const session = await this.sessions.open(sessionId);
    try {
      const agentId = agentIdFrom(await session.getBranch("main"));
      if (agentId !== expectedAgentId) {
        throw new Error(`Conversation ${sessionId} belongs to another agent`);
      }
      const runtime = createSessionRuntime(sessionId, agentId, session);
      this.runtimes.set(sessionId, runtime);
      return runtime;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  private async ensureHarness(runtime: SessionRuntime): Promise<AgentHarness> {
    if (runtime.harness !== undefined) return runtime.harness;
    runtime.opening ??= this.createHarness(runtime);
    const opening = runtime.opening;
    try {
      return await opening;
    } finally {
      if (runtime.opening === opening) runtime.opening = undefined;
    }
  }

  private async createHarness(runtime: SessionRuntime): Promise<AgentHarness> {
    const agent = agentById(runtime.agentId, this.profiles);
    if (agent === undefined) throw new Error(`Unknown agent: ${runtime.agentId}`);
    const created = await AgentHarness.create({
      session: runtime.session,
      streamFn: this.dependencies.createStreamFn(agent.id),
      plugins: [inlinePlugin(systemPromptPlugin(agent.instructions))],
      env: { cwd: process.cwd() },
      model: this.model,
      thinkingLevel: this.thinkingLevel,
    });
    runtime.harness = created.harness;
    runtime.unsubscribe = created.harness.subscribe((event) => this.forward(runtime, event));
    if (created.suspended.length > 0) void this.resumeHarness(runtime, created.harness);
    return created.harness;
  }

  private async resumeHarness(runtime: SessionRuntime, harness: AgentHarness): Promise<void> {
    const result = await harness.resume().catch((error: unknown) => {
      this.emit({ type: "error", sessionId: runtime.id, message: errorMessage(error) });
      return undefined;
    });
    if (result !== undefined && !result.ok) {
      this.emit({ type: "error", sessionId: runtime.id, message: result.error.message });
    }
    if (runtime.harness === harness) {
      await this.emitSnapshot().catch((error: unknown) => {
        this.emit({ type: "error", sessionId: runtime.id, message: errorMessage(error) });
      });
    }
  }

  private async closeHarness(runtime: SessionRuntime): Promise<void> {
    if (runtime.opening !== undefined) await runtime.opening.catch(() => undefined);
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    const harness = runtime.harness;
    runtime.harness = undefined;
    resetLive(runtime);
    if (harness !== undefined) await harness.close();
  }

  private async closeAgentHarnesses(agentId: AgentId): Promise<void> {
    await this.closeHarnessGroup(
      [...this.runtimes.values()].filter((runtime) => runtime.agentId === agentId),
    );
  }

  private async closeAllHarnesses(): Promise<void> {
    await this.closeHarnessGroup([...this.runtimes.values()]);
  }

  private async closeAgentRuntimes(agentId: AgentId): Promise<void> {
    await this.closeRuntimeGroup(
      [...this.runtimes.values()].filter((runtime) => runtime.agentId === agentId),
    );
  }

  private async closeAllRuntimes(): Promise<void> {
    await this.closeRuntimeGroup([...this.runtimes.values()]);
  }

  private async closeHarnessGroup(runtimes: readonly SessionRuntime[]): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of runtimes) {
      await this.closeHarness(runtime).catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close agent harnesses");
  }

  private async closeRuntimeGroup(runtimes: readonly SessionRuntime[]): Promise<void> {
    const errors: unknown[] = [];
    for (const runtime of runtimes) {
      await this.closeRuntime(runtime).catch((error: unknown) => errors.push(error));
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close agent sessions");
  }

  private async closeRuntime(runtime: SessionRuntime): Promise<void> {
    const errors: unknown[] = [];
    await this.closeHarness(runtime).catch((error: unknown) => errors.push(error));
    await runtime.session.close().catch((error: unknown) => errors.push(error));
    if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id);
    if (errors.length > 0)
      throw new AggregateError(errors, `Failed to close session ${runtime.id}`);
  }

  private forward(runtime: SessionRuntime, event: HarnessEvent): void {
    const sessionId = runtime.id;
    if (event.type === "agent_start") {
      resetLive(runtime);
      this.emit({ type: "running", running: true, sessionId });
      return;
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        runtime.live.streamingText += event.assistantMessageEvent.delta;
        this.emit({
          type: "delta",
          entryId: event.entryId,
          sessionId,
          text: event.assistantMessageEvent.delta,
        });
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        runtime.live.thinkingText += event.assistantMessageEvent.delta;
        this.emit({
          type: "thinking-delta",
          entryId: event.entryId,
          sessionId,
          text: event.assistantMessageEvent.delta,
        });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const tool: LiveToolEvent = {
        kind: "started",
        callId: event.toolCallId,
        name: event.toolName,
        args: serializableValue(event.args),
      };
      runtime.live.tools.set(tool.callId, tool);
      this.emit({ type: "tool", entryId: event.entryId, sessionId, tool });
      return;
    }
    if (event.type === "tool_execution_update") {
      const tool: LiveToolEvent = {
        kind: "updated",
        callId: event.toolCallId,
        name: event.toolName,
        args: serializableValue(event.args),
        partialResult: serializableValue(event.partialResult),
      };
      runtime.live.tools.set(tool.callId, tool);
      this.emit({ type: "tool", entryId: event.entryId, sessionId, tool });
      return;
    }
    if (event.type === "tool_execution_end") {
      const tool: LiveToolEvent = {
        kind: "finished",
        callId: event.toolCallId,
        name: event.toolName,
        result: serializableValue(event.result),
        isError: event.isError,
      };
      runtime.live.tools.set(tool.callId, tool);
      this.emit({ type: "tool", entryId: event.entryId, sessionId, tool });
      return;
    }
    if (event.type === "agent_end") {
      resetLive(runtime);
      this.emit({ type: "running", running: false, sessionId });
      this.refreshAfterHarnessEvent(sessionId);
      return;
    }
    if (event.type === "queue_update") {
      this.refreshAfterHarnessEvent(sessionId);
      return;
    }
    if (event.type === "diagnostic" && event.level === "error") {
      this.emit({ type: "error", sessionId, message: event.message });
    }
  }

  private refreshAfterHarnessEvent(sessionId: string): void {
    void this.emitSnapshot().catch((error: unknown) => {
      this.emit({ type: "error", sessionId, message: errorMessage(error) });
    });
  }

  private async emitSnapshot(): Promise<UjiSnapshot> {
    const snapshot = await this.snapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  private async snapshot(): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.auth = await this.dependencies.authStatus();
    return this.buildSnapshot();
  }

  private async buildSnapshot(): Promise<UjiSnapshot> {
    const runtime = this.activeRuntime();
    const entries = runtime === undefined ? [] : await runtime.session.getBranch("main");
    const conversations: ConversationSummary[] = (await this.listConversations()).map(
      ({ agentId, directory }) => ({
        agentId,
        ...directory,
        running: this.runtimes.get(directory.id)?.harness?.state.isBusy ?? directory.liveClaim,
      }),
    );
    return {
      activeAgentId: this.activeAgentId,
      activeSessionId: this.activeSessionId,
      agents: this.profiles.map((agent) => ({ ...agent })),
      auth: this.auth,
      context:
        runtime === undefined ? null : projectContextStatus(entries, this.model.contextWindow),
      conversations,
      live: liveSnapshot(runtime),
      messages: transcriptFromEntries(entries),
      pending: [...(runtime?.harness === undefined ? [] : await runtime.harness.pendingQueue())],
      running: runtime?.harness?.state.isBusy ?? false,
      runtime: this.runtimeSettings(),
    };
  }

  private runtimeSettings(): RuntimeSettings {
    return {
      modelKey: modelKey(this.model),
      models: this.models.map(modelOption),
      thinkingLevel: this.thinkingLevel,
    };
  }

  private async listConversations(): Promise<StoredConversation[]> {
    const metadata = await this.sessions.list();
    const conversations: StoredConversation[] = [];
    for (const item of metadata) {
      const runtime = this.runtimes.get(item.id);
      const session = runtime?.session ?? (await this.sessions.open(item.id));
      try {
        const branch = await session.getBranch("main");
        const agentId = agentIdFrom(branch);
        if (agentId === null || agentById(agentId, this.profiles) === undefined) continue;
        const directory = sessionDirectoryEntryFromLog({
          metadata: item,
          log: await session.getLog(),
          now: Date.now(),
        });
        // A chat the user never wrote in is not a chat yet, so it stays out of the directory.
        if (directory.preview === undefined && directory.name === undefined) continue;
        conversations.push({ agentId, directory });
      } finally {
        if (runtime === undefined) await session.close();
      }
    }
    return conversations.toSorted((a, b) => b.directory.lastActivity - a.directory.lastActivity);
  }

  private loadProfiles(): void {
    if (this.profilesLoaded) return;
    this.profilesLoaded = true;
    this.profiles = this.profileRepo.list();
    if (this.profiles.length > 0 || this.settingsRepo.get(SEEDED_AGENTS_SETTING) === "1") return;
    for (const draft of this.dependencies.initialAgents ?? []) {
      const agent: Agent = { id: newId("agent"), ...draft };
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

function createSessionRuntime(
  id: string,
  agentId: AgentId,
  session: SessionStorage,
): SessionRuntime {
  return {
    agentId,
    id,
    live: { streamingText: "", thinkingText: "", tools: new Map() },
    session,
  };
}

function liveSnapshot(runtime: SessionRuntime | undefined): LiveSnapshot {
  return runtime === undefined
    ? { streamingText: "", thinkingText: "", tools: [] }
    : {
        streamingText: runtime.live.streamingText,
        thinkingText: runtime.live.thinkingText,
        tools: [...runtime.live.tools.values()],
      };
}

function resetLive(runtime: SessionRuntime): void {
  runtime.live.streamingText = "";
  runtime.live.thinkingText = "";
  runtime.live.tools.clear();
}

/** True while a session holds nothing but its agent marker, so it can be handed to a new chat. */
async function isUnusedSession(session: SessionStorage): Promise<boolean> {
  if ((await session.getName()) !== undefined) return false;
  const entries = await session.getBranch("main");
  return !entries.some((entry) => entry.type === "message" && entry.message.role === "user");
}

function agentIdFrom(entries: Awaited<ReturnType<SessionStorage["getBranch"]>>): AgentId | null {
  const marker = entries.find(
    (entry) => entry.type === "custom" && entry.customType === AGENT_ENTRY_TYPE,
  );
  if (marker?.type !== "custom" || typeof marker.data !== "object" || marker.data === null) {
    return null;
  }
  const id = "agentId" in marker.data ? marker.data.agentId : undefined;
  return typeof id === "string" ? id : null;
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

function serializableValue(value: unknown): unknown {
  try {
    return toJsonValue(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
