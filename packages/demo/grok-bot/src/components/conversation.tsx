import { useCallback, type KeyboardEvent } from "react";
import { IconArrowUp, IconStop } from "central-icons";
import * as stylex from "@stylexjs/stylex";

import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  IconBox,
  cn,
} from "@june/ui";
import { mergeStyleProps } from "@june/ui/style";
import { messageText, type ConversationProps, type MessageProps } from "@/view-model";
import { colorVars, controlVars, radiusVars } from "@june/ui/tokens.stylex";
import { AgentAvatar } from "./agent";
import { grokControlVars, grokPrimitiveStyles } from "../theme.stylex";

const styles = stylex.create({
  headerButton: {
    justifyContent: "flex-start",
    gap: controlVars["--june-control-gap-md"],
    paddingInline: controlVars["--june-control-padding-sm"],
    paddingBlock: controlVars["--june-control-padding-xs"],
    borderWidth: 0,
  },
  composerAction: { borderRadius: radiusVars["--june-radius-pill"] },
  composerFrame: { borderRadius: grokControlVars["--grok-control-composer-radius"] },
  messageBubble: { borderRadius: grokControlVars["--grok-control-message-radius"] },
  agentBubble: { backgroundColor: colorVars["--june-color-bubble-agent"] },
  userBubble: {
    backgroundColor: colorVars["--june-color-bubble-user"],
    color: colorVars["--june-color-bubble-user-foreground"],
  },
  notice: { color: colorVars["--june-color-warning"] },
});

export function Conversation({
  agent,
  auth,
  className,
  draft,
  initializing,
  messages,
  notice,
  running,
  signingIn,
  streamingText,
  onDraftChange,
  onLogin,
  onOpenDetails,
  onSend,
  onStop,
}: ConversationProps) {
  const canCompose = !initializing && !running && auth.signedIn;
  const pinMessageScroll = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) node.scrollTop = node.scrollHeight;
    },
    [messages, streamingText],
  );

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section
      className={cn(
        "grid min-w-0 flex-1 grid-rows-[44px_minmax(0,1fr)_auto] bg-background",
        className,
      )}
      aria-label={`Conversation with ${agent.name}`}
    >
      <header className="flex items-center border-b-[.5px] border-border px-3 [-webkit-app-region:drag]">
        <Button
          aria-label={`View ${agent.name} details`}
          className="[-webkit-app-region:no-drag]"
          onClick={onOpenDetails}
          variant="ghost"
          xstyle={[styles.headerButton, grokPrimitiveStyles.noFocusRing]}
        >
          <AgentAvatar agent={agent} size="xs" />
          <strong className="text-[13px] leading-[18px] font-medium">{agent.name}</strong>
        </Button>
      </header>

      <div className="min-h-0 overflow-y-auto px-4 py-6" ref={pinMessageScroll} aria-live="polite">
        {initializing ? (
          <p className="grid h-full place-items-center text-sm text-muted-foreground">
            Opening {agent.name}…
          </p>
        ) : !auth.signedIn ? (
          <div className="grid h-full place-items-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <h1 className="text-base font-medium">Sign in to message {agent.name}</h1>
              <Button
                disabled={signingIn}
                onClick={onLogin}
                size="sm"
                xstyle={grokPrimitiveStyles.noFocusRing}
              >
                {signingIn ? "Waiting for browser…" : "Continue with ChatGPT"}
              </Button>
              {notice && (
                <small className="max-w-sm text-[11px] text-muted-foreground" role="status">
                  {notice}
                </small>
              )}
            </div>
          </div>
        ) : messages.length === 0 && !streamingText ? (
          <div />
        ) : (
          <div className="flex w-full flex-col">
            {messages.map((message, index) => (
              <Message
                key={message.id}
                message={message}
                startsGroup={
                  index > 0 && messages[index - 1]?.message.role !== message.message.role
                }
              />
            ))}
            {streamingText && (
              <div className="flex justify-start py-0.5">
                <div
                  {...mergeStyleProps(
                    stylex.props(styles.messageBubble, styles.agentBubble),
                    "max-w-[min(88%,640px,calc(100%-82px))] px-3 py-2 text-sm leading-5 whitespace-pre-wrap text-foreground",
                  )}
                >
                  {streamingText}
                  <span className="ml-1 inline-block h-3 w-1 animate-[caret-blink_900ms_steps(1)_infinite] bg-current align-[-2px] opacity-30" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 pb-4">
        {notice && auth.signedIn && (
          <p
            {...mergeStyleProps(
              stylex.props(styles.notice),
              "mx-auto mb-2 max-w-3xl text-center text-[10px]",
            )}
            role="status"
          >
            {notice}
          </p>
        )}
        <form onSubmit={onSend}>
          <InputGroup
            data-grok-surface="composer"
            size="xl"
            xstyle={[styles.composerFrame, grokPrimitiveStyles.noFocusRing]}
          >
            <InputGroupTextarea
              aria-label={`Message ${agent.name}`}
              disabled={!canCompose}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder={running ? `${agent.name} is thinking…` : `Message ${agent.name}`}
              rows={1}
              value={draft}
            />
            <InputGroupAddon align="inline-end">
              {running ? (
                <InputGroupButton
                  aria-label="Stop response"
                  onClick={onStop}
                  size="icon-sm"
                  variant="default"
                  xstyle={[styles.composerAction, grokPrimitiveStyles.noFocusRing]}
                >
                  <IconBox glyphSize={12}>
                    <IconStop />
                  </IconBox>
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  aria-label="Send message"
                  disabled={!draft.trim() || !canCompose}
                  size="icon-sm"
                  type="submit"
                  variant="default"
                  xstyle={[styles.composerAction, grokPrimitiveStyles.noFocusRing]}
                >
                  <IconBox glyphSize={12}>
                    <IconArrowUp />
                  </IconBox>
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </section>
  );
}

function Message({ message, startsGroup }: MessageProps) {
  const fromUser = message.message.role === "user";
  const body = messageText(message.message.content);
  return (
    <div
      className={cn(
        "group relative flex py-0.5",
        fromUser ? "justify-end" : "justify-start",
        startsGroup && "mt-3",
      )}
    >
      <div
        className={cn(
          "flex max-w-[min(88%,640px,calc(100%-82px))] flex-col",
          fromUser && "items-end",
        )}
      >
        <div
          data-grok-surface={fromUser ? "bubble-user" : "bubble-agent"}
          {...mergeStyleProps(
            stylex.props(styles.messageBubble, fromUser ? styles.userBubble : styles.agentBubble),
            cn("px-3 py-2 text-sm/5 whitespace-pre-wrap", !fromUser && "text-foreground"),
          )}
        >
          {body}
        </div>
        <time className="pointer-events-none absolute top-full z-10 mt-0.5 px-1 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {formatTime(message.timestamp)}
        </time>
      </div>
    </div>
  );
}

// TODO(schema): Render canonical discriminated message parts directly once the SDK stops exposing
// provider-shaped ResponseItem content; the UI should not need a text recovery helper.
function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    timestamp,
  );
}
