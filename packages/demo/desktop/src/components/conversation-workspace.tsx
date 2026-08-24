import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@uji-ai/ui";
import {
  IconChevronDownSmall,
  IconPlusMedium,
  IconSidebarHiddenRightWide,
  IconStop,
} from "central-icons";
import { useEffect, useState } from "react";

import type { Agent, AgentId } from "../agents.ts";
import type {
  ConversationSummary,
  LiveToolEvent,
  RuntimeSettingsChange,
  UjiSnapshot,
} from "../desktop-api.ts";
import { AgentAvatar } from "./agent-avatar.tsx";
import { Composer, ConnectBar } from "./composer.tsx";
import { ConversationIntro } from "./conversation-intro.tsx";
import { NoticeStack, type Notice } from "./notices.tsx";
import { Transcript, type OptimisticMessage } from "./transcript.tsx";

type Activity = { label: string; tone: "reasoning" | "tool" | "writing" | "waiting" };

export function ConversationWorkspace({
  agent,
  connecting,
  conversation,
  detailsOpen,
  draft,
  liveThinking,
  liveTools,
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
  streamingText,
  waiting,
}: {
  agent: Agent;
  connecting: boolean;
  conversation?: ConversationSummary;
  detailsOpen: boolean;
  draft: string;
  liveThinking: string;
  liveTools: readonly LiveToolEvent[];
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
  streamingText: string;
  waiting: boolean;
}) {
  const running = snapshot.running;
  const activity = describeActivity({ liveThinking, liveTools, stopping, streamingText });

  return (
    <main className="conversation-workspace">
      <header className="conversation-header">
        <DropdownMenu>
          <DropdownMenuTrigger className="conversation-identity" title="Switch assistant">
            <AgentAvatar agent={agent} size="xs" />
            <span className="identity-copy">
              <strong>{agent.name}</strong>
              {running ? (
                <small className="identity-activity" data-tone={activity.tone}>
                  <i aria-hidden="true" />
                  {activity.label}
                  <ElapsedTime />
                </small>
              ) : (
                <small>{conversationSubtitle(agent, conversation)}</small>
              )}
            </span>
            <IconChevronDownSmall size={12} />
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
          {running && (
            <button
              className="header-stop"
              disabled={stopping}
              onClick={onAbort}
              title="Stop the response (Esc)"
              type="button"
            >
              <IconStop size={11} />
              {stopping ? "Stopping" : "Stop"}
            </button>
          )}
          <button
            aria-expanded={detailsOpen}
            aria-label="Open conversation details"
            className="icon-button"
            data-active={detailsOpen || undefined}
            onClick={onDetails}
            title="Conversation details"
            type="button"
          >
            <IconSidebarHiddenRightWide size={15} />
          </button>
        </div>
      </header>

      <Transcript
        agent={agent}
        intro={<ConversationIntro agent={agent} onPrompt={onSend} ready={snapshot.auth.signedIn} />}
        key={snapshot.activeSessionId ?? `new:${agent.id}`}
        liveThinking={liveThinking}
        liveTools={liveTools}
        loading={loading}
        onCancelQueued={onCancelQueued}
        pending={snapshot.pending}
        running={running}
        streamingText={streamingText}
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
  liveThinking,
  liveTools,
  stopping,
  streamingText,
}: {
  liveThinking: string;
  liveTools: readonly LiveToolEvent[];
  stopping: boolean;
  streamingText: string;
}): Activity {
  if (stopping) return { label: "Stopping", tone: "waiting" };
  const activeTool = liveTools.findLast((tool) => tool.kind !== "finished");
  if (activeTool !== undefined) return { label: `Running ${activeTool.name}`, tone: "tool" };
  if (streamingText !== "") return { label: "Writing", tone: "writing" };
  if (liveThinking !== "") return { label: "Reasoning", tone: "reasoning" };
  return { label: "Working", tone: "waiting" };
}

function conversationSubtitle(agent: Agent, conversation?: ConversationSummary): string {
  const title = conversation?.name ?? conversation?.preview ?? "";
  if (title !== "") return title;
  return agent.role === "" ? "New chat" : agent.role;
}
