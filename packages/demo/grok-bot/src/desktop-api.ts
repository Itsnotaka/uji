import type { MessageEntry } from "@june/core";
import type { Agent, AgentDraft, AgentId } from "./agents.ts";

// TODO(protocol): Replace this demo-local facade and its Core MessageEntry leak with the canonical
// sdk.provider/sdk.session protocol types shared by every client transport.
export type AuthStatus = {
  signedIn: boolean;
  label: string;
};

export type JuneSnapshot = {
  activeAgentId: AgentId | null;
  // Empty string means the agent has no conversation yet; the renderer supplies the copy.
  agentPreviews: Record<AgentId, string>;
  agents: Agent[];
  auth: AuthStatus;
  messages: MessageEntry[];
  running: boolean;
};

export type JuneDesktopEvent =
  | { type: "delta"; text: string }
  | { type: "running"; running: boolean }
  | { type: "status"; message: string }
  | { type: "error"; message: string }
  | { type: "snapshot"; snapshot: JuneSnapshot };

export type JuneDesktopApi = {
  initialize(): Promise<JuneSnapshot>;
  login(): Promise<JuneSnapshot>;
  send(message: string): Promise<JuneSnapshot>;
  abort(): Promise<void>;
  newChat(agentId?: AgentId): Promise<JuneSnapshot>;
  selectAgent(agentId: AgentId): Promise<JuneSnapshot>;
  createAgent(draft: AgentDraft): Promise<JuneSnapshot>;
  updateAgent(agentId: AgentId, changes: AgentDraft): Promise<JuneSnapshot>;
  deleteAgent(agentId: AgentId): Promise<JuneSnapshot>;
  onEvent(listener: (event: JuneDesktopEvent) => void): () => void;
};
