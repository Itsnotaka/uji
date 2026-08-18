import {
  AgentHarness,
  SqliteSessionRepo,
  newId,
  type AgentEvent,
  type SessionMetadata,
  type SessionStorage,
  type StreamFn,
  type ThinkingLevel,
} from "@june/core";
import { agentById, agents, june, type Agent, type AgentId } from "../demo-data.ts";
import type { AuthStatus, JuneDesktopEvent, JuneSnapshot } from "../desktop-api.ts";
import { AgentProfileRepo } from "./agent-profile-repo.ts";

const AGENT_ENTRY_TYPE = "june.demo.agent";
const NEW_CONVERSATION = "No messages yet";

export interface JuneHostDependencies {
  authStatus(): Promise<AuthStatus>;
  login(emit: (event: JuneDesktopEvent) => void): Promise<void>;
  createStreamFn(sessionId: string, agentId: AgentId): StreamFn;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface StoredConversation {
  agentId: AgentId;
  metadata: SessionMetadata;
  preview: string;
  updatedAt: number;
}

export class JuneHost {
  private readonly sessions: SqliteSessionRepo;
  private readonly emit: (event: JuneDesktopEvent) => void;
  private readonly dependencies: JuneHostDependencies;
  private readonly profileRepo: AgentProfileRepo;
  private profiles: Agent[] = agents.map((agent) => ({ ...agent }));
  private profilesLoaded = false;
  private activeAgentId: AgentId = june.id;
  private session?: SessionStorage;
  private harness?: AgentHarness;
  private unsubscribe?: () => void;

  constructor(
    databasePath: string,
    emit: (event: JuneDesktopEvent) => void,
    dependencies: JuneHostDependencies,
  ) {
    this.sessions = new SqliteSessionRepo(databasePath);
    this.profileRepo = new AgentProfileRepo(databasePath);
    this.emit = emit;
    this.dependencies = dependencies;
  }

  async initialize(): Promise<JuneSnapshot> {
    await this.loadProfiles();
    if (this.session === undefined) {
      const conversations = await this.listConversations();
      const latest = conversations.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
      if (latest !== undefined) {
        this.activeAgentId = latest.agentId;
        this.session = await this.sessions.open(latest.metadata.id);
      }
    }
    if (this.session !== undefined && (await this.dependencies.authStatus()).signedIn) {
      await this.openHarness();
    }
    return this.snapshot();
  }

  async login(): Promise<JuneSnapshot> {
    await this.loadProfiles();
    await this.dependencies.login(this.emit);
    if (this.session !== undefined) await this.openHarness();
    const snapshot = await this.snapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async send(message: string): Promise<JuneSnapshot> {
    await this.loadProfiles();
    if (!(await this.dependencies.authStatus()).signedIn) {
      throw new Error("Sign in with ChatGPT first");
    }
    if (this.session === undefined) this.session = await this.createSession(this.activeAgentId);
    if ((await this.session.getName()) === undefined)
      await this.session.setName(conversationTitle(message));
    await this.openHarness();
    const result = await this.harness?.prompt(message);
    if (result !== undefined) {
      if (!result.ok) throw result.error;
      if (result.value.kind === "failed") {
        this.emit({ type: "error", message: result.value.error.message });
      }
    }
    const snapshot = await this.snapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async abort(): Promise<void> {
    if (this.harness?.state.isStreaming === true) await this.harness.abort();
  }

  async newChat(agentId: AgentId = this.activeAgentId): Promise<JuneSnapshot> {
    await this.loadProfiles();
    this.assertIdle();
    if (agentById(agentId, this.profiles) === undefined)
      throw new Error(`Unknown agent: ${agentId}`);
    await this.closeActiveSession();
    this.activeAgentId = agentId;
    this.session = await this.createSession(this.activeAgentId);
    if ((await this.dependencies.authStatus()).signedIn) await this.openHarness();
    return this.emitSnapshot();
  }

  async selectAgent(agentId: AgentId): Promise<JuneSnapshot> {
    await this.loadProfiles();
    this.assertIdle();
    const agent = agentById(agentId, this.profiles);
    if (agent === undefined) throw new Error(`Unknown agent: ${agentId}`);
    if (agentId === this.activeAgentId) return this.snapshot();

    await this.closeActiveSession();
    this.activeAgentId = agentId;
    const latest = (await this.listConversations())
      .filter((conversation) => conversation.agentId === agentId)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest !== undefined) this.session = await this.sessions.open(latest.metadata.id);
    if (this.session !== undefined && (await this.dependencies.authStatus()).signedIn) {
      await this.openHarness();
    }
    return this.emitSnapshot();
  }

  async updateAgent(
    agentId: AgentId,
    changes: Pick<Agent, "name" | "role" | "instructions">,
  ): Promise<JuneSnapshot> {
    this.assertIdle();
    await this.loadProfiles();
    const index = this.profiles.findIndex((agent) => agent.id === agentId);
    const current = this.profiles[index];
    if (current === undefined) throw new Error(`Unknown agent: ${agentId}`);
    const updated: Agent = {
      ...current,
      name: requiredText(changes.name, "Name", 80),
      role: requiredText(changes.role, "Role", 120),
      instructions: requiredText(changes.instructions, "Instructions", 12_000),
    };
    this.profileRepo.save(updated);
    this.profiles[index] = updated;

    if (agentId === this.activeAgentId) {
      await this.closeHarness();
      if (this.session !== undefined && (await this.dependencies.authStatus()).signedIn) {
        await this.openHarness();
      }
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
    const agent = agentById(this.activeAgentId, this.profiles);
    if (agent === undefined) throw new Error(`Unknown agent: ${this.activeAgentId}`);
    const sessionId = (await this.session.getMetadata()).id;
    const created = await AgentHarness.create({
      session: this.session,
      streamFn: this.dependencies.createStreamFn(sessionId, this.activeAgentId),
      systemPrompt: agent.instructions,
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

  private forward(event: AgentEvent): void {
    if (event.type === "agent_start") this.emit({ type: "running", running: true });
    if (event.type === "message_update" && event.delta.kind === "text") {
      this.emit({ type: "delta", text: event.delta.text });
    }
    if (event.type === "agent_end") this.emit({ type: "running", running: false });
  }

  private async emitSnapshot(): Promise<JuneSnapshot> {
    const snapshot = await this.snapshot();
    this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  private async snapshot(): Promise<JuneSnapshot> {
    await this.loadProfiles();
    const messages =
      this.session === undefined ? [] : messagesFrom(await this.session.getBranch("main"));
    const previews = Object.fromEntries(
      this.profiles.map((agent) => [agent.id, NEW_CONVERSATION]),
    ) as Record<AgentId, string>;
    const seen = new Set<AgentId>();
    for (const conversation of await this.listConversations()) {
      if (seen.has(conversation.agentId)) continue;
      previews[conversation.agentId] = conversation.preview;
      seen.add(conversation.agentId);
    }
    return {
      activeAgentId: this.activeAgentId,
      agentPreviews: previews,
      agents: this.profiles.map((agent) => ({ ...agent })),
      auth: await this.dependencies.authStatus(),
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
      const session = isActive ? this.session : await this.sessions.open(item.id);
      if (session === undefined) continue;
      try {
        const branch = await session.getBranch("main");
        const messages = messagesFrom(branch);
        conversations.push({
          agentId: agentIdFrom(branch),
          metadata: item,
          preview: previewFrom(messages),
          updatedAt: branch.at(-1)?.timestamp ?? item.createdAt,
        });
      } finally {
        if (!isActive) await session.close();
      }
    }
    return conversations.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  private async loadProfiles(): Promise<void> {
    if (this.profilesLoaded) return;
    this.profilesLoaded = true;
    this.profiles = this.profileRepo.list(agents);
  }
}

function agentIdFrom(entries: Awaited<ReturnType<SessionStorage["getBranch"]>>): AgentId {
  const marker = entries.find(
    (entry) => entry.type === "custom" && entry.customType === AGENT_ENTRY_TYPE,
  );
  if (marker?.type !== "custom" || typeof marker.data !== "object" || marker.data === null) {
    return june.id;
  }
  const id = "agentId" in marker.data ? marker.data.agentId : undefined;
  return typeof id === "string" && agentById(id) !== undefined ? (id as AgentId) : june.id;
}

function messagesFrom(
  entries: Awaited<ReturnType<SessionStorage["getBranch"]>>,
): JuneSnapshot["messages"] {
  return entries.filter((entry) => {
    if (entry.type !== "message") return false;
    const role = entry.message.role;
    return (role === "user" || role === "assistant") && messageText(entry.message.content) !== "";
  }) as JuneSnapshot["messages"];
}

function previewFrom(messages: JuneSnapshot["messages"]): string {
  const latest = messages.at(-1);
  return latest === undefined
    ? NEW_CONVERSATION
    : messageText(latest.message.content) || NEW_CONVERSATION;
}

function conversationTitle(message: string): string {
  const normalized = message.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47).trimEnd()}…`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null || !("text" in part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} is required`);
  if (normalized.length > maxLength)
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  return normalized;
}
