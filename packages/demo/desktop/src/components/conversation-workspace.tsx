import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@uji-ai/ui";
import { IconPlusMedium, IconSidebarSimpleRightWide } from "central-icons";
import { useEffect, useState } from "react";

import type { Agent, AgentId } from "../agents.ts";
import type {
  ConversationSummary,
  LivePart,
  RuntimeSettingsChange,
  UjiSnapshot,
} from "../desktop-api.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import { Composer, ConnectBar } from "./composer.tsx";
import { NoticeStack, type Notice } from "./notices.tsx";
import { Transcript, type OptimisticMessage } from "./transcript.tsx";

type Activity = { label: string; tone: "reasoning" | "tool" | "writing" | "waiting" };

export function ConversationWorkspace({
  agent,
  connecting,
  conversation,
  detailsOpen,
  draft,
  liveParts,
  loading,
  notices,
  onAbort,
  onCancelQueued,
  onConnect,
  onDetails,
  onDismissNotice,
  onDraftChange,
  onNewChat,
  onRuntimeChange,
  onSelectAgent,
  onSend,
  optimisticMessage,
  snapshot,
  stopping,
  waiting,
}: {
  agent: Agent;
  connecting: boolean;
  conversation?: ConversationSummary;
  detailsOpen: boolean;
  draft: string;
  liveParts: readonly LivePart[];
  loading: boolean;
  notices: readonly Notice[];
  onAbort: () => void;
  onCancelQueued: (entryId: string) => void;
  onConnect: () => void;
  onDetails: () => void;
  onDismissNotice: (id: string) => void;
  onDraftChange: (draft: string) => void;
  onNewChat: (agentId: AgentId) => void;
  onRuntimeChange: (change: RuntimeSettingsChange) => void;
  onSelectAgent: (agentId: AgentId) => void;
  onSend: (message: string) => void;
  optimisticMessage?: OptimisticMessage;
  snapshot: UjiSnapshot;
  stopping: boolean;
  waiting: boolean;
}) {
  const running = snapshot.running;
  const activity = describeActivity({ liveParts, stopping });
  const title = conversation?.name ?? agent.name;

  return (
    <main className="conversation-workspace">
      <header className="conversation-header">
        <DropdownMenu>
          <DropdownMenuTrigger className="conversation-identity" title="Switch assistant">
            <AgentAvatar agent={agent} size="xs" />
            <strong>{title}</strong>
            {running && (
              <small className="identity-activity" data-tone={activity.tone}>
                <i aria-hidden="true" />
                {activity.label}
                <ElapsedTime />
              </small>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="identity-menu">
            <DropdownMenuLabel>Assistants</DropdownMenuLabel>
            {snapshot.agents.map((candidate) => (
              <DropdownMenuItem key={candidate.id} onClick={() => onSelectAgent(candidate.id)}>
                <AgentAvatar agent={candidate} size="xs" />
                <span className="menu-copy">
                  <strong>{candidate.name}</strong>
                  {candidate.role !== "" && <small>{candidate.role}</small>}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onNewChat(agent.id)}>
              <IconPlusMedium size={13} />
              New chat with {agent.name}
              <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDetails}>Assistant details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="conversation-header-actions">
          <button
            aria-expanded={detailsOpen}
            aria-label="Open conversation details"
            className="icon-button"
            data-active={detailsOpen || undefined}
            onClick={onDetails}
            title="Conversation details"
            type="button"
          >
            <IconSidebarSimpleRightWide size={17} />
          </button>
        </div>
      </header>

      <Transcript
        agent={agent}
        key={snapshot.activeSessionId ?? `new:${agent.id}`}
        liveParts={liveParts}
        loading={loading}
        onCancelQueued={onCancelQueued}
        pending={snapshot.pending}
        running={running}
        turns={snapshot.messages}
        {...(optimisticMessage === undefined ? {} : { optimisticMessage })}
      />

      <div className="composer-dock">
        <NoticeStack notices={notices} onDismiss={onDismissNotice} />
        {snapshot.auth.signedIn ? (
          <Composer
            agent={agent}
            context={snapshot.context}
            draft={draft}
            onAbort={onAbort}
            onDraftChange={onDraftChange}
            onRuntimeChange={onRuntimeChange}
            onSend={onSend}
            running={running}
            runtime={snapshot.runtime}
            stopping={stopping}
            waiting={waiting}
          />
        ) : (
          <ConnectBar connecting={connecting} label={snapshot.auth.label} onConnect={onConnect} />
        )}
      </div>
    </main>
  );
}

/** Mounted only while a response runs, so the count restarts with every turn. */
function ElapsedTime() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  if (seconds === 0) return null;
  const minutes = Math.floor(seconds / 60);
  const label =
    minutes === 0 ? `${seconds}s` : `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return ` · ${label}`;
}

function describeActivity({
  liveParts,
  stopping,
}: {
  liveParts: readonly LivePart[];
  stopping: boolean;
}): Activity {
  if (stopping) return { label: "Stopping", tone: "waiting" };
  const activeTool = liveParts.findLast((part) => part.kind === "tool");
  if (activeTool?.kind === "tool") {
    return { label: `Running ${activeTool.progress.title ?? "tool"}`, tone: "tool" };
  }
  if (liveParts.some((part) => part.kind === "text")) {
    return { label: "Writing", tone: "writing" };
  }
  if (liveParts.some((part) => part.kind === "thinking")) {
    return { label: "Reasoning", tone: "reasoning" };
  }
  return { label: "Working", tone: "waiting" };
}
