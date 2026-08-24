import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@uji-ai/ui";
import { IconMagnifyingGlass, IconPlusMedium, IconUser } from "central-icons";
import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

import type { Agent, AgentId } from "../agents.ts";
import type { ConversationSummary } from "../desktop-api.ts";
import { AgentAvatar } from "./agent-avatar.tsx";

type SidebarEntry = {
  agent: Agent;
  conversation: ConversationSummary;
};

export function Sidebar({
  accountLabel,
  activeAgentId,
  activeSessionId,
  agents,
  collapsed,
  conversations,
  onCreateAgent,
  onNewChat,
  onResize,
  onSelectConversation,
  onSettings,
  query,
  setQuery,
  signedIn,
  width,
}: {
  accountLabel: string;
  activeAgentId: AgentId | null;
  activeSessionId: string | null;
  agents: readonly Agent[];
  collapsed: boolean;
  conversations: readonly ConversationSummary[];
  onCreateAgent: () => void;
  onNewChat: (agentId?: AgentId) => void;
  onResize: (width: number) => void;
  onSelectConversation: (sessionId: string) => void;
  onSettings: () => void;
  query: string;
  setQuery: (query: string) => void;
  signedIn: boolean;
  width: number;
}) {
  const [searching, setSearching] = useState(false);
  const entries = sidebarEntries(agents, conversations);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(({ agent, conversation }) =>
    `${agent.name} ${agent.role} ${conversation.name ?? ""} ${conversation.preview ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (collapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent): void => {
      onResize(Math.min(400, Math.max(240, startWidth + moveEvent.clientX - startX)));
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  const style = { "--sidebar-width": `${collapsed ? 88 : width}px` } as CSSProperties;

  return (
    <aside
      aria-label="Chats"
      className="conversation-sidebar"
      data-collapsed={collapsed || undefined}
      style={style}
    >
      <div className="sidebar-titlebar">
        <span aria-hidden="true" />
        {agents.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="New chat"
              className="icon-button sidebar-new-chat"
              disabled={activeAgentId === null}
              title="New chat (⌘N)"
            >
              <IconPlusMedium size={14} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="sidebar-menu">
              <DropdownMenuLabel>New chat with</DropdownMenuLabel>
              {agents.map((agent) => (
                <DropdownMenuItem key={agent.id} onClick={() => onNewChat(agent.id)}>
                  <AgentAvatar agent={agent} size="xs" />
                  <span className="menu-copy">
                    <strong>{agent.name}</strong>
                    {agent.role !== "" && <small>{agent.role}</small>}
                  </span>
                  {agent.id === activeAgentId && <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onCreateAgent}>
                <IconPlusMedium size={13} />
                New assistant
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button
            aria-label="New chat"
            className="icon-button sidebar-new-chat"
            disabled={activeAgentId === null}
            onClick={() => onNewChat()}
            title="New chat (⌘N)"
            type="button"
          >
            <IconPlusMedium size={14} />
          </button>
        )}
      </div>

      {searching || query !== "" ? (
        <label className="sidebar-search-control" data-editing="true">
          <IconMagnifyingGlass aria-hidden="true" size={14} />
          <span className="visually-hidden">Search chats</span>
          <input
            autoComplete="off"
            autoFocus
            id="conversation-search"
            onBlur={() => {
              if (query === "") setSearching(false);
            }}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              setQuery("");
              setSearching(false);
            }}
            placeholder="Search"
            type="search"
            value={query}
          />
        </label>
      ) : (
        <button
          className="sidebar-search-control"
          id="conversation-search-trigger"
          onClick={() => setSearching(true)}
          type="button"
        >
          <IconMagnifyingGlass aria-hidden="true" size={14} />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
      )}

      <nav aria-label="Chats" className="sidebar-scroll">
        <div className="sidebar-list">
          {visibleEntries.map(({ agent, conversation }) => {
            const shortcut = conversations.findIndex(
              (candidate) => candidate.id === conversation.id,
            );
            const title = conversation.name ?? conversation.preview ?? agent.name;
            return (
              <button
                aria-current={conversation.id === activeSessionId ? "page" : undefined}
                className="agent-row"
                key={conversation.id}
                onClick={() => onSelectConversation(conversation.id)}
                title={collapsed ? `${agent.name} — ${title}` : undefined}
                type="button"
              >
                <span className="agent-avatar-carrier">
                  <AgentAvatar agent={agent} size="lg" />
                </span>
                <span className="row-copy">
                  <strong>{title}</strong>
                  {conversation.running ? (
                    <small className="row-working">
                      <span aria-hidden="true" className="typing-indicator">
                        <i />
                        <i />
                        <i />
                      </span>
                      {agent.name} is replying
                    </small>
                  ) : (
                    <small>{agent.name}</small>
                  )}
                </span>
                <span className="row-trailing">
                  <time dateTime={new Date(conversation.lastActivity).toISOString()}>
                    {relativeTime(conversation.lastActivity)}
                  </time>
                  {shortcut >= 0 && shortcut < 9 && <kbd>⌘{shortcut + 1}</kbd>}
                </span>
              </button>
            );
          })}
          {visibleEntries.length === 0 && !collapsed && (
            <p className="sidebar-empty">
              {query === "" ? "No chats yet. Press ⌘N to start one." : "No matching chats"}
            </p>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-footer-action" onClick={onCreateAgent} type="button">
          <span className="footer-action-icon">
            <IconPlusMedium size={14} />
          </span>
          <span className="footer-action-label">New assistant</span>
        </button>
        <button className="account-row" onClick={onSettings} type="button">
          <span className="account-mark" data-offline={signedIn ? undefined : true}>
            <IconUser size={14} />
          </span>
          <span className="row-copy">
            <strong>Account</strong>
            <small>{accountLabel}</small>
          </span>
        </button>
      </div>

      <div aria-hidden="true" className="sidebar-resize-handle" onPointerDown={beginResize} />
    </aside>
  );
}

/** Chats only: an assistant without a chat belongs in the new-chat menu, not the chat list. */
function sidebarEntries(
  agents: readonly Agent[],
  conversations: readonly ConversationSummary[],
): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const conversation of conversations) {
    const agent = agents.find((candidate) => candidate.id === conversation.agentId);
    if (agent !== undefined) entries.push({ agent, conversation });
  }
  return entries.toSorted(
    (left, right) => right.conversation.lastActivity - left.conversation.lastActivity,
  );
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}
