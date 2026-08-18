import type { AvatarSize } from "@june/ui";
import type { FormEvent } from "react";

import type { Agent, AgentId } from "./demo-data";
import type { AuthStatus, JuneSnapshot } from "./desktop-api";

export type AgentAvatarProps = {
  agent: Agent;
  className?: string;
  size?: AvatarSize;
};

export type SidebarProps = {
  agents: readonly Agent[];
  auth: AuthStatus;
  className?: string;
  collapsed: boolean;
  previews: Readonly<Record<AgentId, string>>;
  running: boolean;
  signingIn: boolean;
  selectedId: AgentId;
  onLogin: () => void;
  onEdit: (id: AgentId) => void;
  onNewChat: (id: AgentId) => void;
  onOpenSearch: () => void;
  onResize: (width: number) => void;
  onSelect: (id: AgentId) => void;
};

export type SearchPaletteProps = {
  agents: readonly Agent[];
  open: boolean;
  running: boolean;
  selectedId: AgentId;
  onClose: () => void;
  onEdit: (id: AgentId) => void;
  onNewChat: (id: AgentId) => void;
  onSelect: (id: AgentId) => void;
};

export type ConversationProps = {
  agent: Agent;
  auth: AuthStatus;
  className?: string;
  draft: string;
  initializing: boolean;
  messages: JuneSnapshot["messages"];
  notice?: string;
  running: boolean;
  signingIn: boolean;
  streamingText: string;
  onDraftChange: (value: string) => void;
  onLogin: () => void;
  onOpenDetails: () => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
};

export type BotDetailsProps = {
  agent: Agent;
  className?: string;
  overlay: boolean;
  width: number;
  onClose: () => void;
  onResize: (width: number) => void;
  onSave: (changes: Pick<Agent, "name" | "role" | "instructions">) => Promise<void>;
};

export type MessageProps = {
  message: JuneSnapshot["messages"][number];
  startsGroup: boolean;
};

export function messageText(
  content: JuneSnapshot["messages"][number]["message"]["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text ?? "").join("");
}

export function latestMessagePreview(messages: JuneSnapshot["messages"] | undefined): string {
  const latest = messages?.at(-1);
  if (latest === undefined) return "No messages yet";
  return messageText(latest.message.content) || "No messages yet";
}
