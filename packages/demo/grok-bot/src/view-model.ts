import type { AvatarSize } from "@june/ui";
import type { Agent, AgentId } from "./agents";
import type { AuthStatus, JuneSnapshot } from "./desktop-api";
import type { ThemePreference } from "./theme";

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
  selectedId: AgentId | null;
  themePreference: ThemePreference;
  onEdit: (id: AgentId) => void;
  onNewChat: (id: AgentId | null) => void;
  onResize: (width: number) => void;
  onSelect: (id: AgentId) => void;
  onThemeChange: (preference: ThemePreference) => void;
};

export type SearchPaletteProps = {
  agents: readonly Agent[];
  running: boolean;
  selectedId: AgentId | null;
  onEdit: (id: AgentId) => void;
  onNewChat: (id: AgentId) => void;
  onSelect: (id: AgentId) => void;
};

export type ConversationProps = {
  agent: Agent;
  auth: AuthStatus;
  className?: string;
  initializing: boolean;
  messages: JuneSnapshot["messages"];
  notice?: string;
  running: boolean;
  streamingText: string;
  onOpenDetails: () => void;
};

export type BotDetailsProps = {
  agent: Agent;
  className?: string;
  overlay: boolean;
  width: number;
  onClose: () => void;
  onResize: (width: number) => void;
};

export type MessageProps = {
  message: JuneSnapshot["messages"][number];
  startsGroup: boolean;
};

// content is the schema's v0 Responses wire shape (string | ContentPart[] | undefined);
// this collapses once @june/schema ships canonical discriminated parts.
export function messageText(
  content: JuneSnapshot["messages"][number]["message"]["content"],
): string {
  if (typeof content === "string") return content;
  return content?.map((part) => part.text ?? "").join("") ?? "";
}
