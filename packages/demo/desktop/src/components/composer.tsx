import type { ModelThinkingLevel } from "@uji-ai/ai";
import type { ContextStatus } from "@uji-ai/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Textarea,
} from "@uji-ai/ui";
import {
  IconArrowUp,
  IconBrain,
  IconChip,
  IconMicrophone,
  IconPlusMedium,
  IconStop,
} from "central-icons";
import type { FormEvent, KeyboardEvent } from "react";

import type { Agent } from "../agents.ts";
import type { RuntimeSettings, RuntimeSettingsChange } from "../desktop-api.ts";
import { PersonAvatar } from "./agent-avatar.tsx";

export function Composer({
  agent,
  context,
  draft,
  onAbort,
  onDraftChange,
  onRuntimeChange,
  onSend,
  running,
  runtime,
  stopping,
  waiting,
}: {
  agent: Agent;
  context: ContextStatus | null;
  draft: string;
  onAbort: () => void;
  onDraftChange: (draft: string) => void;
  onRuntimeChange: (change: RuntimeSettingsChange) => void;
  onSend: (message: string) => void;
  running: boolean;
  runtime: RuntimeSettings;
  stopping: boolean;
  waiting: boolean;
}) {
  const model = runtime.models.find((candidate) => candidate.key === runtime.modelKey);
  const canSubmit = draft.trim() !== "";
  const locked = running || waiting;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (canSubmit) onSend(draft);
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className="composer" onSubmit={submit}>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Chat options"
          className="composer-action composer-plus"
          title="Model, reasoning, and context"
        >
          <IconPlusMedium size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="composer-menu" side="top">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={locked}>
              <IconChip size={14} />
              <span className="menu-copy">
                <strong>Model</strong>
                <small>{model?.name ?? "Choose a model"}</small>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="composer-menu">
              <DropdownMenuLabel>Model for the next reply</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={(value: string) =>
                  onRuntimeChange({ kind: "model", modelKey: value })
                }
                value={runtime.modelKey}
              >
                {runtime.models.map((option) => (
                  <DropdownMenuRadioItem key={option.key} value={option.key}>
                    <span className="menu-copy">
                      <strong>{option.name}</strong>
                      <small>
                        {option.provider} · {formatTokens(option.contextWindow)} context
                      </small>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {model !== undefined && model.thinkingLevels.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={locked}>
                <IconBrain size={14} />
                <span className="menu-copy">
                  <strong>Reasoning</strong>
                  <small>{thinkingLabel(runtime.thinkingLevel)}</small>
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="composer-menu">
                <DropdownMenuLabel>How long the model reasons</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  onValueChange={(value: ModelThinkingLevel) =>
                    onRuntimeChange({ kind: "thinking", thinkingLevel: value })
                  }
                  value={runtime.thinkingLevel}
                >
                  {model.thinkingLevels.map((level) => (
                    <DropdownMenuRadioItem key={level} value={level}>
                      {thinkingLabel(level)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <ContextRow context={context} />
        </DropdownMenuContent>
      </DropdownMenu>

      <Textarea
        aria-label={`Message ${agent.name}`}
        autoFocus
        className="composer-input"
        id="message-composer"
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={submitOnEnter}
        placeholder={running ? "Queue the next message" : `Message ${agent.name}`}
        rows={1}
        value={draft}
      />

      <div className="composer-actions">
        {running && (
          <button
            aria-label={stopping ? "Stopping response" : "Stop response"}
            className="composer-action stop-button"
            disabled={stopping}
            onClick={onAbort}
            title={stopping ? "Stopping…" : "Stop (Esc)"}
            type="button"
          >
            <IconStop size={14} />
          </button>
        )}
        {canSubmit ? (
          <button
            aria-label={running ? "Queue message" : "Send message"}
            className="composer-action send-button"
            title={running ? "Queue message" : "Send"}
            type="submit"
          >
            <IconArrowUp size={16} />
          </button>
        ) : (
          !running && (
            <button
              aria-label="Voice message"
              className="composer-action send-button microphone-button"
              disabled
              title="Voice input is not part of this demo"
              type="button"
            >
              <IconMicrophone size={16} />
            </button>
          )
        )}
      </div>
    </form>
  );
}

export function ConnectBar({
  connecting,
  label,
  onConnect,
}: {
  connecting: boolean;
  label: string;
  onConnect: () => void;
}) {
  return (
    <div className="composer composer-connect">
      <PersonAvatar name="Account" offline size="md" />
      <span className="connect-copy">
        <strong>Connect ChatGPT to chat</strong>
        <small>{connecting ? "Finish the sign-in in your browser." : label}</small>
      </span>
      <Button disabled={connecting} onClick={onConnect} size="sm">
        {connecting ? "Waiting…" : "Connect"}
      </Button>
    </div>
  );
}

function ContextRow({ context }: { context: ContextStatus | null }) {
  if (context === null) return null;
  const percent = Math.min(100, Math.max(0, Math.round(context.percent ?? 0)));
  return (
    <>
      <DropdownMenuSeparator />
      <div
        className="context-row"
        data-full={percent >= 80 || undefined}
        title={`${formatTokens(context.estimatedTokens)} of ${formatTokens(context.contextWindow)} tokens used`}
      >
        <span className="menu-copy">
          <strong>Context</strong>
          <small>
            {formatTokens(context.estimatedTokens)} of {formatTokens(context.contextWindow)}
          </small>
        </span>
        <span className="context-row-track">
          <i style={{ width: `${percent}%` }} />
        </span>
      </div>
    </>
  );
}

function thinkingLabel(level: ModelThinkingLevel): string {
  return level === "off" ? "No reasoning" : level.charAt(0).toLocaleUpperCase() + level.slice(1);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}
