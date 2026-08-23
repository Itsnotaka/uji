import type { Api, Model } from "@uji-ai/ai/types";
import { AgentHarness, type HarnessEvent } from "@uji-ai/core/harness";
import { systemPromptPlugin } from "@uji-ai/core/plugins/system-prompt";
import { inlinePlugin } from "@uji-ai/core/plugins/types";
import { SqliteSessionRepo } from "@uji-ai/core/session/sqlite";
import {
  newId,
  type MessageEntry,
  type SessionMetadata,
  type SessionStorage,
} from "@uji-ai/core/session/types";
import type { StreamFn, ThinkingLevel } from "@uji-ai/core/types";
import { agentById, type Agent, type AgentDraft, type AgentId } from "../agents.ts";
import type { AuthStatus, UjiDesktopEvent, UjiSnapshot } from "../desktop-api.ts";
import { messageText } from "../messages.ts";
import { AgentProfileRepo } from "./agent-profile-repo.ts";

const AGENT_ENTRY_TYPE = "uji.demo.agent";

export interface UjiHostDependencies {
  authStatus(): Promise<AuthStatus>;
  login(emit: (event: UjiDesktopEvent) => void): Promise<void>;
  createStreamFn(agentId: AgentId): StreamFn;
  model: Model<Api>;
  initialAgents?: readonly AgentDraft[];
  thinkingLevel?: ThinkingLevel;
}

interface StoredConversation {
  agentId: AgentId;
  metadata: SessionMetadata;
  updatedAt: number;
}

export class UjiHost {
  private readonly sessions: SqliteSessionRepo;
  private readonly emit: (event: UjiDesktopEvent) => void;
  private readonly dependencies: UjiHostDependencies;
  private readonly profileRepo: AgentProfileRepo;
  private profiles: Agent[] = [];
  private profilesLoaded = false;
  private activeAgentId: AgentId | null = null;
  private session?: SessionStorage;
  private harness?: AgentHarness;
  private unsubscribe?: () => void;

  constructor(
    databasePath: string,
    emit: (event: UjiDesktopEvent) => void,
    dependencies: UjiHostDependencies,
  ) {
    this.sessions = new SqliteSessionRepo(databasePath);
    this.profileRepo = new AgentProfileRepo(databasePath);
    this.emit = emit;
    this.dependencies = dependencies;
  }

  async initialize(): Promise<UjiSnapshot> {
    this.loadProfiles();
    const conversations = await this.listConversations();
    if (this.session === undefined) {
      const latest = conversations[0];
      if (latest !== undefined) {
        this.activeAgentId = latest.agentId;
        this.session = await this.sessions.open(latest.metadata.id);
      }
    }
    if (this.activeAgentId === null) this.activeAgentId = this.profiles[0]?.id ?? null;
    const auth = await this.dependencies.authStatus();
    if (this.session !== undefined && auth.signedIn) await this.openHarness();
    return this.buildSnapshot(auth);
  }

  async login(): Promise<UjiSnapshot> {
    this.loadProfiles();
    await this.dependencies.login(this.emit);
    if (this.session !== undefined) await this.openHarness();
    return this.emitSnapshot();
  }

  async send(message: string): Promise<UjiSnapshot> {
    this.loadProfiles();
    if (!(await this.dependencies.authStatus()).signedIn) {
      throw new Error("Sign in with ChatGPT first");
    }
    const agentId = this.activeAgentId;
    if (agentId === null) throw new Error("Create an agent first");
    if (this.session === undefined) this.session = await this.createSession(agentId);
    if ((await this.session.getName()) === undefined)
      await this.session.setName(conversationTitle(message));
    await this.openHarness();
    const harness = this.harness;
    if (harness === undefined) throw new Error("Could not open the agent harness");
    const submitted = await harness.submit(message);
    if (!submitted.ok) throw submitted.error;
    if (submitted.value.disposition === "started") {
      const result = await harness.waitForIdle();
      if (result !== undefined) {
        if (!result.ok) throw result.error;
        if (!("operation" in result.value) && result.value.kind === "failed") {
          this.emit({ type: "error", message: result.value.error.message });
        }
      }
    }
    return this.emitSnapshot();
  }

  async abort(): Promise<void> {
    if (this.harness?.state.isStreaming === true) await this.harness.abort();
  }

  async newChat(agentId?: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertIdle();
    const targetId = agentId ?? this.activeAgentId;
    if (targetId === null) throw new Error("Create an agent first");
    if (agentById(targetId, this.profiles) === undefined)
      throw new Error(`Unknown agent: ${targetId}`);
    await this.closeActiveSession();
    this.activeAgentId = targetId;
    this.session = await this.createSession(targetId);
    if ((await this.dependencies.authStatus()).signedIn) await this.openHarness();
    return this.emitSnapshot();
  }

  async selectAgent(agentId: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertIdle();
    if (agentById(agentId, this.profiles) === undefined)
      throw new Error(`Unknown agent: ${agentId}`);
    if (agentId === this.activeAgentId) return this.snapshot();
    await this.closeActiveSession();
    this.activeAgentId = agentId;
    await this.openLatestSession(agentId);
    return this.emitSnapshot();
  }

  async createAgent(draft: AgentDraft): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertIdle();
    const agent: Agent = { id: newId("agent"), ...draft };
    this.profileRepo.insert(agent);
    this.profiles.push(agent);
    await this.closeActiveSession();
    this.activeAgentId = agent.id;
    return this.emitSnapshot();
  }

  async updateAgent(agentId: AgentId, changes: AgentDraft): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertIdle();
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    const current = this.profiles[index];
    if (current === undefined) throw new Error(`Unknown agent: ${agentId}`);
    const updated: Agent = { id: current.id, ...changes };
    this.profileRepo.update(updated);
    this.profiles[index] = updated;

    if (agentId === this.activeAgentId) {
      await this.closeHarness();
      if (this.session !== undefined && (await this.dependencies.authStatus()).signedIn) {
        await this.openHarness();
      }
    }
    return this.emitSnapshot();
  }

  async deleteAgent(agentId: AgentId): Promise<UjiSnapshot> {
    this.loadProfiles();
    this.assertIdle();
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    if (index < 0) throw new Error(`Unknown agent: ${agentId}`);
    // Session deletion is outside SessionRepo; listConversations omits sessions
    // whose agent profile no longer exists.
    this.profileRepo.delete(agentId);
    this.profiles.splice(index, 1);
    if (agentId === this.activeAgentId) {
      await this.closeActiveSession();
      this.activeAgentId = this.profiles[0]?.id ?? null;
      if (this.activeAgentId !== null) await this.openLatestSession(this.activeAgentId);
    }
    return this.emitSnapshot();
  }

  async close(): Promise<void> {
    await this.closeActiveSession();
    await this.sessions.close();
    this.profileRepo.close();
  }

  private assertIdle(): void {
    if (this.harness?.state.isStreaming === true) {
      throw new Error("Wait for the current response or stop it before switching conversations");
    }
  }

  private async openLatestSession(agentId: AgentId): Promise<void> {
    const latest = (await this.listConversations()).find(
      (conversation) => conversation.agentId === agentId,
    );
    if (latest !== undefined) this.session = await this.sessions.open(latest.metadata.id);
    if (this.session !== undefined && (await this.dependencies.authStatus()).signedIn) {
      await this.openHarness();
    }
  }

  private async createSession(agentId: AgentId): Promise<SessionStorage> {
    const session = await this.sessions.create();
    await session.appendEntry(
      {
        type: "custom",
        id: newId("e"),
        customType: AGENT_ENTRY_TYPE,
        data: { agentId },
      },
      "main",
    );
    return session;
  }

  private async openHarness(): Promise<void> {
    if (this.harness !== undefined) return;
    if (this.session === undefined) throw new Error("Could not open the agent session");
    if (this.activeAgentId === null) throw new Error("Create an agent first");
    const agent = agentById(this.activeAgentId, this.profiles);
    if (agent === undefined) throw new Error(`Unknown agent: ${this.activeAgentId}`);
    const created = await AgentHarness.create({
      session: this.session,
      streamFn: this.dependencies.createStreamFn(agent.id),
      plugins: [inlinePlugin(systemPromptPlugin(agent.instructions))],
      env: { cwd: process.cwd() },
      model: this.dependencies.model,
      thinkingLevel: this.dependencies.thinkingLevel,
    });
    this.harness = created.harness;
    this.unsubscribe = this.harness.subscribe((event) => this.forward(event));
  }

  private async closeActiveSession(): Promise<void> {
    await this.closeHarness();
    await this.session?.close();
    this.session = undefined;
  }

  private async closeHarness(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const harness = this.harness;
    this.harness = undefined;
    if (harness !== undefined) await harness.close();
  }

  private forward(event: HarnessEvent): void {
    if (event.type === "agent_start") this.emit({ type: "running", running: true });
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      this.emit({ type: "delta", text: event.assistantMessageEvent.delta });
    }
    if (event.type === "agent_end") this.emit({ type: "running", running: false });
  }

  private async emitSnapshot(): Promise<UjiSnapshot> {
    const snapshot = await this.snapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  private async snapshot(): Promise<UjiSnapshot> {
    this.loadProfiles();
    return this.buildSnapshot(await this.dependencies.authStatus());
  }

  private async buildSnapshot(auth: AuthStatus): Promise<UjiSnapshot> {
    const messages =
      this.session === undefined ? [] : messagesFrom(await this.session.getBranch("main"));
    return {
      activeAgentId: this.activeAgentId,
      agents: this.profiles.map((agent) => ({ ...agent })),
      auth,
      messages,
      running: this.harness?.state.isStreaming ?? false,
    };
  }

  private async listConversations(): Promise<StoredConversation[]> {
    const metadata = await this.sessions.list();
    const conversations: StoredConversation[] = [];
    const activeSessionId = (await this.session?.getMetadata())?.id;
    for (const item of metadata) {
      const isActive = activeSessionId === item.id;
      const session: SessionStorage | undefined = isActive
        ? this.session
        : await this.sessions.open(item.id);
      if (session === undefined) continue;
      try {
        const branch = await session.getBranch("main");
        const agentId = agentIdFrom(branch);
        if (agentId === null || agentById(agentId, this.profiles) === undefined) continue;
        conversations.push({
          agentId,
          metadata: item,
          updatedAt: branch.at(-1)?.timestamp ?? item.createdAt,
        });
      } finally {
        if (!isActive) await session.close();
      }
    }
    return conversations.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  private loadProfiles(): void {
    if (this.profilesLoaded) return;
    this.profilesLoaded = true;
    this.profiles = this.profileRepo.list();
    if (this.profiles.length > 0) return;
    for (const draft of this.dependencies.initialAgents ?? []) {
      const agent: Agent = { id: newId("agent"), ...draft };
      this.profileRepo.insert(agent);
      this.profiles.push(agent);
    }
  }
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

function messagesFrom(entries: Awaited<ReturnType<SessionStorage["getBranch"]>>): MessageEntry[] {
  return entries.filter((entry): entry is MessageEntry => {
    if (entry.type !== "message") return false;
    const role = entry.message.role;
    return (role === "user" || role === "assistant") && messageText(entry.message.content) !== "";
  });
}

function conversationTitle(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47).trimEnd()}…`;
}
