import type { MessageEntry } from "@uji-ai/core";
import type { Agent, AgentId } from "./agents.ts";

// TODO(protocol): Replace this demo-local facade and its Core MessageEntry leak with the
// sdk.provider/sdk.session protocol types shared by every client transport.
export type AuthStatus = {
  signedIn: boolean;
  label: string;
};

export type UjiSnapshot = {
  activeAgentId: AgentId | null;
  agents: Agent[];
  auth: AuthStatus;
  messages: MessageEntry[];
  running: boolean;
};

export type UjiDesktopEvent =
  | { type: "delta"; text: string }
  | { type: "running"; running: boolean }
  | { type: "status"; message: string }
  | { type: "error"; message: string }
  | { type: "snapshot"; snapshot: UjiSnapshot };

export type UjiDesktopApi = {
  initialize(): Promise<UjiSnapshot>;
  login(): Promise<UjiSnapshot>;
  send(message: string): Promise<UjiSnapshot>;
  abort(): Promise<void>;
  newChat(agentId?: AgentId): Promise<UjiSnapshot>;
  selectAgent(agentId: AgentId): Promise<UjiSnapshot>;
  onEvent(listener: (event: UjiDesktopEvent) => void): () => void;
};
