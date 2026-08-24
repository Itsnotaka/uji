import type { ModelThinkingLevel } from "@uji-ai/ai";
import type { ContextStatus, PendingQueueItem, SessionDirectoryEntry, Turn } from "@uji-ai/core";
import type { Agent, AgentDraft, AgentId } from "./agents.ts";

// TODO(protocol): Replace this demo-local facade with the sdk.sessions,
// sdk.messages, and sdk.provider protocol once those namespaces ship.
export type AuthStatus = {
  signedIn: boolean;
  label: string;
};

export type ConversationSummary = SessionDirectoryEntry & {
  agentId: AgentId;
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
  activeSessionId: string | null;
  agents: readonly Agent[];
  auth: AuthStatus;
  context: ContextStatus | null;
  conversations: readonly ConversationSummary[];
  live: LiveSnapshot;
  messages: readonly Turn[];
  pending: readonly PendingQueueItem[];
  running: boolean;
  runtime: RuntimeSettings;
};

export type LiveSnapshot = {
  streamingText: string;
  thinkingText: string;
  tools: readonly LiveToolEvent[];
};

export type LiveToolEvent =
  | {
      kind: "started";
      args: unknown;
      callId: string;
      name: string;
    }
  | {
      kind: "updated";
      args: unknown;
      callId: string;
      name: string;
      partialResult: unknown;
    }
  | {
      kind: "finished";
      callId: string;
      isError: boolean;
      name: string;
      result: unknown;
    };

export type UjiDesktopEvent =
  | { type: "delta"; entryId: string; sessionId: string; text: string }
  | { type: "thinking-delta"; entryId: string; sessionId: string; text: string }
  | { type: "tool"; entryId: string; sessionId: string; tool: LiveToolEvent }
  | { type: "running"; running: boolean; sessionId: string }
  | { type: "status"; message: string }
  | { type: "error"; message: string; sessionId?: string }
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
  selectConversation(sessionId: string): Promise<UjiSnapshot>;
  renameConversation(sessionId: string, name: string): Promise<UjiSnapshot>;
  createAgent(draft: AgentDraft): Promise<UjiSnapshot>;
  updateAgent(agentId: AgentId, draft: AgentDraft): Promise<UjiSnapshot>;
  deleteAgent(agentId: AgentId): Promise<UjiSnapshot>;
  updateRuntimeSettings(change: RuntimeSettingsChange): Promise<UjiSnapshot>;
  onEvent(listener: (event: UjiDesktopEvent) => void): () => void;
};
