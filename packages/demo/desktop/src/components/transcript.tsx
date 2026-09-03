import type { PendingItem, Turn, TurnPart } from "@uji-ai/core";
import {
  IconArrowDown,
  IconBrain,
  IconCheckmark1Small,
  IconClock,
  IconCrossSmall,
  IconHammer,
  IconWarningSign,
} from "central-icons";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { Agent } from "../agents.ts";
import type { LivePart } from "../desktop-api.ts";
import { messageText } from "../messages.ts";

export interface OptimisticMessage {
  body: string;
  id: string;
}

export function Transcript({
  agent,
  liveParts,
  loading,
  optimisticMessage,
  onCancelQueued,
  pending,
  running,
  turns,
}: {
  agent: Agent;
  liveParts: readonly LivePart[];
  loading: boolean;
  optimisticMessage?: OptimisticMessage;
  onCancelQueued: (entryId: string) => void;
  pending: readonly PendingItem[];
  running: boolean;
  turns: readonly Turn[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    if (!pinned.current) {
      setUnseen(true);
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [liveParts, optimisticMessage, pending.length, turns.length]);

  function trackScroll(node: HTMLDivElement): void {
    const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    pinned.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(false);
  }

  function jumpToLatest(): void {
    const node = scroller.current;
    if (node === null) return;
    pinned.current = true;
    setAtBottom(true);
    setUnseen(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }

  const empty =
    turns.length === 0 && pending.length === 0 && optimisticMessage === undefined && !running;
  const lastText = liveParts.findLast((part) => part.kind === "text");
  const hasLiveText = lastText !== undefined;

  return (
    <div className="transcript-viewport">
      <div
        className="transcript-scroll"
        onScroll={(event) => trackScroll(event.currentTarget)}
        ref={scroller}
      >
        <div aria-label={`Conversation with ${agent.name}`} className="transcript" role="log">
          {loading ? (
            <TranscriptSkeleton />
          ) : empty ? null : (
            <>
              {turns.map((turn) => (
                <TurnView key={turnKey(turn)} turn={turn} />
              ))}

              {optimisticMessage !== undefined && (
                <div className="message-row user-row" data-pending="true">
                  <div className="message-bubble user-bubble">{optimisticMessage.body}</div>
                </div>
              )}

              {pending.map((item) => (
                <div className="queued-message" key={item.entryId}>
                  <IconClock aria-hidden="true" size={14} />
                  <span>
                    <strong>Queued</strong>
                    {messageText(item.content)}
                  </span>
                  <button
                    aria-label="Cancel queued message"
                    onClick={() => onCancelQueued(item.entryId)}
                    type="button"
                  >
                    <IconCrossSmall size={12} />
                  </button>
                </div>
              ))}

              {liveParts.map((part) => {
                switch (part.kind) {
                  case "thinking":
                    return (
                      <div
                        className="live-activity"
                        key={`thinking:${part.entryId}:${String(part.contentIndex)}`}
                      >
                        <details className="detail-row" open>
                          <summary>
                            <IconBrain aria-hidden="true" size={15} />
                            <span>Reasoning</span>
                            <span className="activity-status">Working</span>
                          </summary>
                          <pre>{part.text}</pre>
                        </details>
                      </div>
                    );
                  case "tool":
                    return (
                      <div className="live-activity" key={`tool:${part.callId}`}>
                        <LiveTool tool={part} />
                      </div>
                    );
                  case "text":
                    return (
                      <div
                        className="message-row assistant-row live-assistant-row"
                        key={`text:${part.entryId}:${String(part.contentIndex)}`}
                      >
                        <div className="assistant-copy">
                          {part.text}
                          {part === lastText && (
                            <span aria-hidden="true" className="stream-caret" />
                          )}
                        </div>
                      </div>
                    );
                  default: {
                    const exhaustive: never = part;
                    return exhaustive;
                  }
                }
              })}

              {running && !hasLiveText && (
                <div className="message-row assistant-row live-assistant-row">
                  <div className="assistant-copy">
                    <TypingIndicator />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {!atBottom && !empty && (
        <button
          className="jump-latest"
          data-unseen={unseen || undefined}
          onClick={jumpToLatest}
          type="button"
        >
          <IconArrowDown size={12} />
          {unseen ? "New reply below" : "Jump to latest"}
        </button>
      )}
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div aria-hidden="true" className="transcript-skeleton">
      <span className="skeleton-line skeleton-user" />
      <span className="skeleton-line skeleton-wide" />
      <span className="skeleton-line skeleton-medium" />
      <span className="skeleton-line skeleton-short" />
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  switch (turn.kind) {
    case "turn":
      return (
        <div className="turn" data-outcome={turn.outcome}>
          {turn.parts.map((part, index) => (
            <TurnPartView key={`${turn.id}-${index}`} part={part} />
          ))}
          {turn.outcome !== "completed" && (
            <div className="turn-outcome" role="status">
              <IconWarningSign size={14} />
              {turn.outcome === "aborted" ? "Response stopped" : "Response failed"}
            </div>
          )}
        </div>
      );
    case "compaction":
      return (
        <TimelineMarker>
          Context compacted after {formatTokenCount(turn.entry.tokensBefore)} tokens
        </TimelineMarker>
      );
    case "model_change":
      return <TimelineMarker>Model changed to {turn.entry.modelId}</TimelineMarker>;
    case "branch_summary":
      return <TimelineMarker>Summarized an earlier branch</TimelineMarker>;
    case "custom":
      return <TimelineMarker>{humanize(turn.entry.customType)}</TimelineMarker>;
    default: {
      const exhaustive: never = turn;
      return exhaustive;
    }
  }
}

function TurnPartView({ part }: { part: TurnPart }) {
  switch (part.kind) {
    case "user":
      return (
        <div className="message-row user-row">
          <div className="message-bubble user-bubble">{messageText(part.content)}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="message-row assistant-row">
          <div className="assistant-copy">{part.text}</div>
        </div>
      );
    case "thinking":
      return (
        <details className="detail-row reasoning-row">
          <summary>
            <IconBrain aria-hidden="true" size={15} />
            <span>Reasoning</span>
            <span className="activity-status">Done</span>
          </summary>
          <pre>{part.text}</pre>
        </details>
      );
    case "tool":
      return <ToolPartView part={part} />;
    case "note":
      return (
        <div className="transcript-note" role="status">
          <IconWarningSign size={14} />
          {part.text}
        </div>
      );
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

function ToolPartView({ part }: { part: Extract<TurnPart, { kind: "tool" }> }) {
  const result = part.result;
  return (
    <details className="detail-row tool-row">
      <summary>
        <IconHammer aria-hidden="true" size={15} />
        <span>{humanize(part.toolName)}</span>
        <span className="tool-preview">{toolPreview(part.args)}</span>
        <span className="activity-status" data-error={result?.isError || undefined}>
          {result === undefined ? "Pending" : result.isError ? "Failed" : "Done"}
        </span>
      </summary>
      <div className="tool-details">
        <DetailBlock label="Input" value={part.args} />
        {result !== undefined && (
          <>
            <DetailBlock label="Output" value={result.output} />
            {result.details !== undefined && <DetailBlock label="Details" value={result.details} />}
          </>
        )}
      </div>
    </details>
  );
}

function LiveTool({ tool }: { tool: Extract<LivePart, { kind: "tool" }> }) {
  return (
    <details className="detail-row tool-row">
      <summary>
        <IconHammer aria-hidden="true" size={15} />
        <span>{tool.progress.title ?? "Tool"}</span>
        <span className="activity-status">Running</span>
      </summary>
      {(tool.progress.text !== "" || tool.progress.details !== undefined) && (
        <div className="tool-details">
          {tool.progress.text !== "" && <DetailBlock label="Progress" value={tool.progress.text} />}
          {tool.progress.details !== undefined && (
            <DetailBlock label="Details" value={tool.progress.details} />
          )}
        </div>
      )}
    </details>
  );
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="detail-block">
      <strong>{label}</strong>
      <pre>{prettyValue(value)}</pre>
    </div>
  );
}

function TimelineMarker({ children }: { children: ReactNode }) {
  return (
    <div className="timeline-marker">
      <IconCheckmark1Small aria-hidden="true" size={12} />
      {children}
    </div>
  );
}

function TypingIndicator() {
  return (
    <span aria-label="Thinking" className="typing-indicator" role="status">
      <i />
      <i />
      <i />
    </span>
  );
}

function turnKey(turn: Turn): string {
  return turn.kind === "turn" ? turn.id : turn.entry.id;
}

function humanize(value: string): string {
  const words = value.replaceAll(/[_-]+/g, " ").trim();
  return words === "" ? "Tool" : words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

function toolPreview(value: unknown): string {
  if (isRecord(value)) {
    for (const key of ["command", "path", "query"]) {
      if (key in value && typeof value[key] === "string") return value[key];
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function prettyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Unserializable value";
  }
}
