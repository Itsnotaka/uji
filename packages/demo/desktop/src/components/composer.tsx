import type { ModelThinkingLevel } from "@uji-ai/ai";
import type { ContextStatus } from "@uji-ai/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Textarea,
} from "@uji-ai/ui";
import {
  IconArrowUp,
  IconBrain,
  IconChevronDownSmall,
  IconChip,
  IconMicrophone,
  IconPlusMedium,
  IconStop,
  IconUser,
} from "central-icons";
import type { FormEvent, KeyboardEvent } from "react";

import type { Agent } from "../agents.ts";
import type { RuntimeSettings, RuntimeSettingsChange } from "../desktop-api.ts";

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
  const lockReason = running ? "Stop the response to change this" : undefined;

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

      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            aria-label="Attach a file"
            className="composer-action composer-utility"
            disabled
            title="Attachments are not part of this demo"
            type="button"
          >
            <IconPlusMedium size={14} />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger
              className="composer-pill"
              disabled={running || waiting}
              title={lockReason ?? "Choose the model for the next reply"}
            >
              <IconChip size={13} />
              <span>{model?.name ?? "Model"}</span>
              <IconChevronDownSmall size={11} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="composer-menu" side="top">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
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
            </DropdownMenuContent>
          </DropdownMenu>

          {model !== undefined && model.thinkingLevels.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="composer-pill"
                disabled={running || waiting}
                title={lockReason ?? "Choose how long the model reasons"}
              >
                <IconBrain size={13} />
                <span>{thinkingLabel(runtime.thinkingLevel)}</span>
                <IconChevronDownSmall size={11} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="composer-menu" side="top">
                <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
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
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <ContextPill context={context} />
        </div>

        <div className="composer-actions">
          {running ? (
            <button
              aria-label={stopping ? "Stopping response" : "Stop response"}
              className="composer-action stop-button"
              disabled={stopping}
              onClick={onAbort}
              title={stopping ? "Stopping…" : "Stop (Esc)"}
              type="button"
            >
              <IconStop size={13} />
            </button>
          ) : (
            <button
              aria-label="Voice message"
              className="composer-action composer-utility microphone-button"
              disabled
              title="Voice input is not part of this demo"
              type="button"
            >
              <IconMicrophone size={15} />
            </button>
          )}
          <button
            aria-label={running ? "Queue message" : "Send message"}
            className="composer-action send-button"
            disabled={!canSubmit}
            title={running ? "Queue message" : "Send"}
            type="submit"
          >
            <IconArrowUp size={14} />
          </button>
        </div>
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
    <div className="composer-connect">
      <span className="account-mark">
        <IconUser size={14} />
      </span>
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

function ContextPill({ context }: { context: ContextStatus | null }) {
  if (context === null) return null;
  const percent = Math.min(100, Math.max(0, Math.round(context.percent ?? 0)));
  if (percent < 1) return null;
  return (
    <span
      className="context-pill"
      data-full={percent >= 80 || undefined}
      title={`${formatTokens(context.estimatedTokens)} of ${formatTokens(context.contextWindow)} tokens used`}
    >
      <span className="context-pill-track">
        <i style={{ width: `${percent}%` }} />
      </span>
      {percent}%
    </span>
  );
}

function thinkingLabel(level: ModelThinkingLevel): string {
  return level === "off" ? "No reasoning" : level.charAt(0).toLocaleUpperCase() + level.slice(1);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}
