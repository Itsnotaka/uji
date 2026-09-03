import type { ModelThinkingLevel } from "@uji-ai/ai";
import type {
  ContextStatus,
  PendingItem,
  SessionEvent,
  SessionId,
  ToolProgress,
  Turn,
} from "@uji-ai/core";
import type { Agent, AgentDraft, AgentId } from "./agents.ts";

export type AuthStatus = {
  signedIn: boolean;
  label: string;
};

export type ConversationSummary = {
  id: SessionId;
  agentId: AgentId;
  name?: string;
  preview?: string;
  lastActivity: number;
  running: boolean;
};

export type DesktopModelOption = {
  contextWindow: number;
  id: string;
  key: string;
  maxTokens: number;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevels: readonly ModelThinkingLevel[];
};

export type RuntimeSettings = {
  modelKey: string;
  models: readonly DesktopModelOption[];
  thinkingLevel: ModelThinkingLevel;
};

export type RuntimeSettingsChange =
  | { kind: "model"; modelKey: string }
  | { kind: "thinking"; thinkingLevel: ModelThinkingLevel };

export type UjiSnapshot = {
  activeAgentId: AgentId | null;
  activeSessionId: SessionId | null;
  agents: readonly Agent[];
  auth: AuthStatus;
  context: ContextStatus | null;
  conversations: readonly ConversationSummary[];
  live: LiveSnapshot;
  messages: readonly Turn[];
  pending: readonly PendingItem[];
  running: boolean;
  runtime: RuntimeSettings;
};

export type LiveSnapshot = {
  parts: readonly LivePart[];
};

export type LivePart =
  | {
      kind: "text";
      contentIndex: number;
      entryId: string;
      text: string;
    }
  | {
      kind: "thinking";
      contentIndex: number;
      entryId: string;
      text: string;
    }
  | {
      kind: "tool";
      callId: string;
      entryId: string;
      progress: ToolProgress;
    };

export type UjiDesktopEvent =
  | { type: "session"; event: SessionEvent; sessionId: SessionId }
  | { type: "status"; message: string }
  | { type: "error"; message: string; sessionId?: SessionId }
  | { type: "snapshot"; snapshot: UjiSnapshot };

export type UjiDesktopApi = {
  initialize(): Promise<UjiSnapshot>;
  login(): Promise<UjiSnapshot>;
  logout(): Promise<UjiSnapshot>;
  send(message: string): Promise<UjiSnapshot>;
  cancelQueued(entryId: string): Promise<UjiSnapshot>;
  abort(): Promise<void>;
  newChat(agentId?: AgentId): Promise<UjiSnapshot>;
  selectAgent(agentId: AgentId): Promise<UjiSnapshot>;
  selectConversation(sessionId: SessionId): Promise<UjiSnapshot>;
  renameConversation(sessionId: SessionId, name: string): Promise<UjiSnapshot>;
  createAgent(draft: AgentDraft): Promise<UjiSnapshot>;
  updateAgent(agentId: AgentId, draft: AgentDraft): Promise<UjiSnapshot>;
  deleteAgent(agentId: AgentId): Promise<UjiSnapshot>;
  updateRuntimeSettings(change: RuntimeSettingsChange): Promise<UjiSnapshot>;
  onEvent(listener: (event: UjiDesktopEvent) => void): () => void;
};
