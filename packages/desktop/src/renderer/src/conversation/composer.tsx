/**
 * The input surface, shaped like Cursor's Agents composer (layout reference
 * only; no code ported): the text field on top, a controls row inside the
 * frame below it — model chip on the left, send or stop on the right. The
 * frame is shared by the draft screen and the thread.
 *
 * Admission is open (invariant 5): sending while a run is live is not an
 * error — it steers, and the receipt's disposition is the only difference the
 * client sees. The strip above the field shows still-pending queue items with
 * cancel and "send now" (`redeliver`), and Esc requests a durable abort.
 */
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { PendingItem, SessionId } from "@uji-ai/core";
import { Icon } from "../components/icons.tsx";
import { focus, IconButton } from "../components/ui.tsx";
import {
  useConfigureSession,
  useDefaultModel,
  useModels,
  useSession,
  useSessionSnapshot,
} from "../queries.ts";
import { uji } from "../uji.ts";
import type { ComposerViewState } from "../layout/session-view-state.ts";
import { formatContextWindow, ModelPicker } from "./model-picker.tsx";
import { composerStyles } from "./styles.stylex.ts";

/**
 * Session-bound chip: shows the configured model — or the default the next
 * run would actually use — and configures on pick. The context gauge sits
 * beside it because the two describe the same thing: how much of this model
 * the conversation has used.
 */
function SessionModelChip({ sessionId }: { sessionId: SessionId }): ReactElement | null {
  const models = useModels();
  const fallback = useDefaultModel();
  const session = useSession(sessionId);
  const snapshot = useSessionSnapshot(sessionId);
  const configure = useConfigureSession(sessionId);
  const context = snapshot.data?.context;
  const options = models.data ?? [];
  const configured = session.data?.config.model;
  const current =
    configured === undefined
      ? options.find(
          (option) => option.provider === fallback.data?.provider && option.id === fallback.data.id,
        )
      : options.find(
          (option) =>
            option.id === configured.id &&
            (configured.provider === undefined || option.provider === configured.provider),
        );

  return (
    <>
      <ModelPicker
        current={current}
        options={options}
        thinkingLevel={session.data?.config.thinkingLevel}
        disabled={configure.isPending}
        onModelSelect={(option, thinkingLevel) => {
          configure.mutate({
            model: { provider: option.provider, id: option.id },
            thinkingLevel,
          });
        }}
        onThinkingLevel={(thinkingLevel) => configure.mutate({ thinkingLevel })}
      />
      {context?.percent !== undefined && (
        <span
          {...stylex.props(composerStyles.gauge)}
          title={
            context.contextWindow === undefined
              ? `${String(context.estimatedTokens)} tokens`
              : `${String(context.estimatedTokens)} tokens of ${formatContextWindow(context.contextWindow)}`
          }
        >
          {String(Math.round(context.percent))}%
        </span>
      )}
    </>
  );
}

export interface ComposerFrameProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** A run is live: empty-input Esc and the idle button both request an abort. */
  busy?: boolean;
  onAbort?: () => void;
  /** The model chip slot, left side of the controls row. */
  model?: ReactNode;
  inputRef?: (element: HTMLTextAreaElement | null) => void;
  selectionStart?: number;
  selectionEnd?: number;
  onSelectionChange?: (start: number, end: number) => void;
  onFocusChange?: (focused: boolean) => void;
}

/** The frame both composers share: autosizing textarea plus the controls row. */
export function ComposerFrame({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus = false,
  disabled = false,
  busy = false,
  onAbort,
  model,
  inputRef,
  selectionStart,
  selectionEnd,
  onSelectionChange,
  onFocusChange,
}: ComposerFrameProps): ReactElement {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null || selectionStart === undefined || selectionEnd === undefined) return;
    if (area.selectionStart === selectionStart && area.selectionEnd === selectionEnd) return;
    area.setSelectionRange(selectionStart, selectionEnd);
  }, [selectionEnd, selectionStart, value]);

  const resize = (area: HTMLTextAreaElement): void => {
    area.style.height = "auto";
    area.style.height = `${String(Math.min(area.scrollHeight, 180))}px`;
  };

  const submit = (): void => {
    if (disabled || value.trim() === "") return;
    onSubmit();
    const area = areaRef.current;
    if (area !== null) area.style.height = "auto";
  };

  return (
    <form
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      {...stylex.props(composerStyles.frame)}
    >
      <textarea
        ref={(element) => {
          areaRef.current = element;
          inputRef?.(element);
        }}
        aria-label="Message"
        {...stylex.props(composerStyles.input)}
        rows={1}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus && !disabled}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          resize(event.target);
        }}
        onSelect={(event) =>
          onSelectionChange?.(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)
        }
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
          if (
            event.key === "Escape" &&
            busy &&
            value.trim() === "" &&
            !disabled &&
            onAbort !== undefined
          ) {
            event.preventDefault();
            onAbort();
          }
        }}
      />
      <div {...stylex.props(composerStyles.controls)}>
        {model}
        <span {...stylex.props(composerStyles.spacer)} />
        {busy && value.trim() === "" && onAbort !== undefined ? (
          <button
            type="button"
            aria-label="Stop the run"
            title="Stop (Esc)"
            disabled={disabled}
            onClick={onAbort}
            {...stylex.props(composerStyles.send, focus.ring, composerStyles.stop)}
          >
            <Icon name="square" size={12} />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            title="Send (Enter)"
            disabled={disabled || value.trim() === ""}
            {...stylex.props(composerStyles.send, focus.ring)}
          >
            <Icon name="arrow-up" size={15} />
          </button>
        )}
      </div>
    </form>
  );
}

function pendingText(item: PendingItem): string {
  if (typeof item.content === "string") return item.content;
  return item.content
    .map((part) => ("type" in part && part.type === "text" ? part.text : ""))
    .join("");
}

export function Composer({
  sessionId,
  working,
  pending,
  disabled = false,
  viewState,
  onViewStateChange,
  inputRef,
  autoFocus = true,
}: {
  sessionId: SessionId;
  working: boolean;
  pending: readonly PendingItem[];
  disabled?: boolean;
  viewState?: ComposerViewState;
  onViewStateChange?: (update: (current: ComposerViewState) => ComposerViewState) => void;
  inputRef?: (element: HTMLTextAreaElement | null) => void;
  autoFocus?: boolean;
}): ReactElement {
  const [localViewState, setLocalViewState] = useState<ComposerViewState>({
    draft: "",
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
  });
  const currentViewState = viewState ?? localViewState;

  const updateViewState = (update: (current: ComposerViewState) => ComposerViewState): void => {
    if (viewState === undefined) setLocalViewState(update);
    onViewStateChange?.(update);
  };

  const send = (): void => {
    const content = currentViewState.draft.trim();
    if (disabled || content === "") return;
    updateViewState((current) => ({ ...current, draft: "", selectionStart: 0, selectionEnd: 0 }));
    void uji.messages.send({ sessionId, content }).catch(() =>
      updateViewState((current) => ({
        ...current,
        draft: content,
        selectionStart: content.length,
        selectionEnd: content.length,
      })),
    );
  };

  const abort = (): void => {
    if (disabled) return;
    void uji.runs.abort({ sessionId });
  };

  return (
    <div role="region" aria-label="Conversation input" {...stylex.props(composerStyles.region)}>
      {pending.map((item) => (
        <div role="status" key={item.entryId} {...stylex.props(composerStyles.queued)}>
          <Icon name="clock" size={12} />
          <span {...stylex.props(composerStyles.queuedText)}>{pendingText(item)}</span>
          {item.delivery !== "steer" && (
            <button
              type="button"
              {...stylex.props(composerStyles.queuedAction, focus.ring)}
              onClick={() =>
                void uji.messages.redeliver({
                  sessionId,
                  entryId: item.entryId,
                  delivery: "steer",
                })
              }
            >
              Send now
            </button>
          )}
          <IconButton
            icon="x"
            label="Cancel queued message"
            size={12}
            onClick={() => void uji.messages.cancel({ sessionId, entryId: item.entryId })}
          />
        </div>
      ))}

      <ComposerFrame
        value={currentViewState.draft}
        onChange={(draft) =>
          updateViewState((current) => ({
            ...current,
            draft,
            selectionStart: Math.min(current.selectionStart, draft.length),
            selectionEnd: Math.min(current.selectionEnd, draft.length),
          }))
        }
        onSubmit={send}
        placeholder={working ? "Steer the run…" : "Message Uji…"}
        autoFocus={autoFocus}
        disabled={disabled}
        busy={working}
        onAbort={abort}
        model={disabled ? undefined : <SessionModelChip sessionId={sessionId} />}
        inputRef={inputRef}
        selectionStart={currentViewState.selectionStart}
        selectionEnd={currentViewState.selectionEnd}
        onSelectionChange={(selectionStart, selectionEnd) =>
          updateViewState((current) => ({ ...current, selectionStart, selectionEnd }))
        }
        onFocusChange={(focused) => updateViewState((current) => ({ ...current, focused }))}
      />
    </div>
  );
}
