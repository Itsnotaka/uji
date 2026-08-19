import { Fragment, useCallback, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  IconArrowUp,
  IconExclamationCircle,
  IconSidebarHiddenRightWide,
  IconSidebarSimpleRightWide,
  IconStop,
} from "central-icons";
import * as stylex from "@stylexjs/stylex";

import {
  Avatar,
  AvatarFallback,
  avatarToneSolid,
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  IconBox,
  cn,
  type AvatarSize,
} from "@june/ui";
import { mergeStyleProps } from "@june/ui/style";
import {
  borderVars,
  colorVars,
  controlVars,
  elevationVars,
  fontVars,
  motionVars,
  radiusVars,
} from "@june/ui/tokens.stylex";
import type { Agent } from "@/agents";
import type { AuthStatus, JuneSnapshot } from "@/desktop-api";
import { useAbort } from "@/hooks/use-abort";
import { useLogin } from "@/hooks/use-login";
import { useSendMessage } from "@/hooks/use-send-message";
import { strings } from "@/strings";
import { messageText } from "@/messages";
import { grokControlVars } from "../theme.stylex";

export type ConversationProps = {
  agent: Agent;
  auth: AuthStatus;
  className?: string;
  detailsOpen: boolean;
  initializing: boolean;
  messages: JuneSnapshot["messages"];
  notice?: string;
  running: boolean;
  streamingText: string;
  onToggleDetails: () => void;
};

type Turn = {
  id: string;
  body: string;
  fromUser: boolean;
  timestamp: number;
  continues: boolean;
  opensDay: boolean;
};

const caretBlink = stylex.keyframes({ "50%": { opacity: 0 } });

const styles = stylex.create({
  header: {
    borderBottomWidth: borderVars["--june-border-hairline-width"],
    borderBottomStyle: "solid",
    borderBottomColor: colorVars["--june-color-border-weak"],
  },
  // Rows opt out of scroll anchoring so the trailing anchor is the only candidate:
  // growth below the last row pins the view to the bottom, and a reader who has
  // scrolled up keeps their place because the anchor is then out of the scrollport.
  scroller: { overscrollBehavior: "contain" },
  // Chromium suppresses scroll anchoring while a scroller sits at offset 0, so a fresh
  // conversation would never follow its own stream. The extra pixel guarantees the pin
  // below lands on a non-zero offset and anchoring engages from the first token.
  log: { minHeight: "calc(100% + 1px)" },
  row: { overflowAnchor: "none" },
  scrollAnchor: { height: "1px", overflowAnchor: "auto" },
  daySeparator: {
    color: colorVars["--june-color-muted-foreground"],
    fontVariantNumeric: "tabular-nums",
  },
  bubble: {
    maxWidth: "80%",
    borderRadius: grokControlVars["--grok-control-message-radius"],
    overflowWrap: "anywhere",
  },
  agentBubble: {
    backgroundColor: colorVars["--june-color-bubble-agent"],
    color: colorVars["--june-color-foreground"],
  },
  userBubble: {
    backgroundColor: colorVars["--june-color-bubble-user"],
    color: colorVars["--june-color-bubble-user-foreground"],
  },
  // A bubble that continues its speaker's run tightens the corner it joins.
  continuesAgent: { borderStartStartRadius: radiusVars["--june-radius-control"] },
  continuesUser: { borderStartEndRadius: radiusVars["--june-radius-control"] },
  timestamp: {
    color: colorVars["--june-color-muted-foreground"],
    fontVariantNumeric: "tabular-nums",
    transitionProperty: "opacity",
    transitionDuration: {
      default: motionVars["--june-motion-fast"],
      "@media (prefers-reduced-motion: reduce)": "0s",
    },
    transitionTimingFunction: motionVars["--june-motion-ease-out"],
  },
  caret: {
    animationName: { default: caretBlink, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "900ms",
    animationTimingFunction: "steps(1)",
    animationIterationCount: "infinite",
    backgroundColor: "currentColor",
    opacity: 0.4,
    verticalAlign: "-2px",
  },
  suggestion: {
    height: "auto",
    justifyContent: "flex-start",
    paddingBlock: controlVars["--june-control-padding-sm"],
    paddingInline: controlVars["--june-control-padding-lg"],
    borderColor: colorVars["--june-color-border-weak"],
    borderRadius: radiusVars["--june-radius-pill"],
    fontSize: fontVars["--june-font-size-label"],
    fontWeight: fontVars["--june-font-weight-regular"],
    lineHeight: fontVars["--june-leading-label"],
    whiteSpace: "normal",
    textAlign: "start",
  },
  connect: { borderRadius: radiusVars["--june-radius-pill"] },
  connectCard: {
    borderWidth: borderVars["--june-border-hairline-width"],
    borderStyle: "solid",
    borderColor: colorVars["--june-color-border"],
    borderRadius: radiusVars["--june-radius-dialog"],
    backgroundColor: colorVars["--june-color-field-background"],
    boxShadow: elevationVars["--june-elevation-field"],
  },
  composerFrame: { borderRadius: grokControlVars["--grok-control-composer-radius"] },
  composerAction: { borderRadius: radiusVars["--june-radius-pill"] },
  noticeIcon: { color: colorVars["--june-color-warning"] },
});

const column = "mx-auto w-full max-w-2xl";

// The host keys this component by agent id, so the draft resets per agent.
export function Conversation({
  agent,
  auth,
  className,
  detailsOpen,
  initializing,
  messages,
  notice,
  running,
  streamingText,
  onToggleDetails,
}: ConversationProps) {
  const sendMessage = useSendMessage();
  const login = useLogin();
  const abort = useAbort();
  const [draft, setDraft] = useState("");
  // Bumped by every send so the list re-pins to the bottom on the reader's own action.
  const [sendCount, setSendCount] = useState(0);
  const canCompose = !initializing && !running && auth.signedIn && !sendMessage.isPending;
  const turns = conversationTurns(messages);
  const thinking = running && streamingText === "";
  const streaming = streamingText !== "" || thinking;
  const lastTurn = turns.at(-1);
  // The answer in flight is happening now, so it opens a day of its own whenever the
  // stored history stopped on an earlier day.
  const streamOpensDay = lastTurn === undefined || !sameDay(lastTurn.timestamp, Date.now());

  const pinToBottom = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) node.scrollTop = node.scrollHeight;
    },
    // Streaming growth is pinned by scroll anchoring instead, so a reader who scrolls
    // up mid-answer is never yanked back down.
    [initializing, sendCount],
  );

  function send(body: string) {
    if (!canCompose || body === "") return;
    setDraft("");
    setSendCount((count) => count + 1);
    sendMessage.mutate(body);
  }

  function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send(draft.trim());
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section
      className={cn(
        "bg-background grid min-w-0 flex-1 grid-rows-[44px_minmax(0,1fr)_auto]",
        className,
      )}
      aria-label={strings.conversation.conversationWith(agent.name)}
    >
      <header
        {...mergeStyleProps(
          stylex.props(styles.header),
          "flex min-w-0 items-center gap-2 px-3 [-webkit-app-region:drag]",
        )}
      >
        <ToneAvatar agent={agent} size="xs" />
        <span className="text-label min-w-0 truncate font-medium">{agent.name}</span>
        <Button
          aria-expanded={detailsOpen}
          aria-label={strings.conversation.viewDetails(agent.name)}
          className="ml-auto [-webkit-app-region:no-drag]"
          onClick={onToggleDetails}
          size="icon-sm"
          variant="ghost"
        >
          <IconBox glyphSize={14}>
            {detailsOpen ? <IconSidebarHiddenRightWide /> : <IconSidebarSimpleRightWide />}
          </IconBox>
        </Button>
      </header>

      <div
        {...mergeStyleProps(stylex.props(styles.scroller), "min-h-0 overflow-y-auto px-6 py-8")}
        ref={pinToBottom}
      >
        {initializing ? (
          <p className="text-label text-muted-foreground grid h-full place-items-center">
            {strings.conversation.opening(agent.name)}
          </p>
        ) : turns.length === 0 && !streaming ? (
          // Signed out is not a gate: the agent still introduces itself, and the connect
          // card above the composer carries the one action that is available.
          <AgentHero agent={agent} onSuggest={send} ready={canCompose} suggest={auth.signedIn} />
        ) : (
          <div
            aria-live="polite"
            {...mergeStyleProps(stylex.props(styles.log), cn(column, "flex flex-col gap-1"))}
            role="log"
          >
            {turns.map((turn) => (
              <Fragment key={turn.id}>
                {turn.opensDay && <DaySeparator timestamp={turn.timestamp} />}
                <Message turn={turn} />
              </Fragment>
            ))}
            {streaming && streamOpensDay && <DaySeparator timestamp={Date.now()} />}
            {streaming && (
              // Deltas would otherwise re-announce the whole answer on every token; the
              // finished turn lands in the log above and is announced once. It always opens
              // a run rather than continuing the previous answer: it follows the message the
              // reader just sent, which `messages` only carries once the run finishes.
              <div
                aria-live="off"
                {...mergeStyleProps(
                  stylex.props(styles.row),
                  cn("flex items-end gap-2", !streamOpensDay && "mt-3"),
                )}
              >
                <div
                  {...mergeStyleProps(
                    stylex.props(styles.bubble, styles.agentBubble),
                    "text-body px-3.5 py-2 whitespace-pre-wrap",
                  )}
                >
                  {streamingText}
                  <span
                    {...mergeStyleProps(
                      stylex.props(styles.caret),
                      "ml-0.5 inline-block h-3.5 w-0.5",
                    )}
                  />
                </div>
              </div>
            )}
            <div {...stylex.props(styles.scrollAnchor)} />
          </div>
        )}
      </div>

      <div className="px-6 pt-2 pb-5">
        <div className={cn(column, "flex flex-col gap-2")}>
          {notice !== undefined && (
            <p className="text-detail flex items-center justify-center gap-1.5" role="status">
              {/* Warning tone rides the glyph. As text it misses AA against the light theme. */}
              <IconBox glyphSize={12} xstyle={styles.noticeIcon}>
                <IconExclamationCircle />
              </IconBox>
              {notice}
            </p>
          )}
          {!auth.signedIn && (
            <ConnectCard onConnect={() => login.mutate(undefined)} pending={login.isPending} />
          )}
          <form onSubmit={submitDraft}>
            <InputGroup size="xl" xstyle={styles.composerFrame}>
              <InputGroupTextarea
                aria-label={strings.conversation.messageLabel(agent.name)}
                // Enter is a no-op while a turn runs, so the field goes dead too rather than
                // silently swallowing a draft; Stop is the affordance that stays live.
                disabled={!canCompose}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={
                  running
                    ? strings.conversation.thinkingPlaceholder(agent.name)
                    : strings.conversation.messagePlaceholder(agent.name)
                }
                rows={1}
                value={draft}
              />
              <InputGroupAddon align="inline-end">
                {running ? (
                  <InputGroupButton
                    aria-label={strings.conversation.stop}
                    onClick={() => abort.mutate(undefined)}
                    size="icon-sm"
                    variant="secondary"
                    xstyle={styles.composerAction}
                  >
                    <IconBox glyphSize={12}>
                      <IconStop />
                    </IconBox>
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    aria-label={strings.conversation.send}
                    disabled={draft.trim() === "" || !canCompose}
                    size="icon-sm"
                    type="submit"
                    variant="default"
                    xstyle={[styles.composerAction, avatarToneSolid[agent.avatar]]}
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
      </div>
    </section>
  );
}

function ToneAvatar({ agent, size }: { agent: Agent; size: AvatarSize }) {
  return (
    <Avatar shape="rounded" size={size} tone={agent.avatar} variant="solid">
      <AvatarFallback>{initial(agent.name)}</AvatarFallback>
    </Avatar>
  );
}

function ConnectCard({ pending, onConnect }: { pending: boolean; onConnect: () => void }) {
  return (
    <div
      {...mergeStyleProps(stylex.props(styles.connectCard), "flex items-center gap-3 px-4 py-3")}
    >
      {/* The only CTA string available is the title verbatim, so the card states the
          problem once and lets the button carry the action. */}
      <p className="text-label min-w-0">{strings.conversation.connectBody}</p>
      <Button
        className="ml-auto shrink-0"
        disabled={pending}
        onClick={onConnect}
        size="sm"
        xstyle={styles.connect}
      >
        {pending ? strings.onboarding.connectPending : strings.onboarding.connect}
      </Button>
    </div>
  );
}

function AgentHero({
  agent,
  ready,
  suggest,
  onSuggest,
}: {
  agent: Agent;
  ready: boolean;
  suggest: boolean;
  onSuggest: (body: string) => void;
}) {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <ToneAvatar agent={agent} size="lg" />
          <div className="flex flex-col gap-1">
            <h1 className="text-title font-medium">{agent.name}</h1>
            {agent.role !== "" && <p className="text-label text-muted-foreground">{agent.role}</p>}
          </div>
        </div>
        {suggest && (
          <>
            <div className="flex w-full flex-col gap-2">
              {strings.conversation.suggestions.map((suggestion) => (
                <Button
                  disabled={!ready}
                  key={suggestion}
                  onClick={() => onSuggest(suggestion)}
                  variant="outline"
                  xstyle={styles.suggestion}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
            <p className="text-detail text-muted-foreground">{strings.conversation.emptyHint}</p>
          </>
        )}
      </div>
    </div>
  );
}

function DaySeparator({ timestamp }: { timestamp: number }) {
  return (
    <time
      {...mergeStyleProps(
        stylex.props(styles.row, styles.daySeparator),
        "text-detail block py-4 text-center",
      )}
      dateTime={new Date(timestamp).toISOString()}
    >
      {`${dayLabel(timestamp)} ${formatTime(timestamp)}`}
    </time>
  );
}

function Message({ turn }: { turn: Turn }) {
  return (
    <div
      {...mergeStyleProps(
        stylex.props(styles.row),
        cn(
          "group flex items-end gap-2",
          turn.fromUser && "flex-row-reverse",
          // A day separator already spaces the turn it introduces.
          !turn.continues && !turn.opensDay && "mt-3",
        ),
      )}
    >
      <div
        {...mergeStyleProps(
          stylex.props(
            styles.bubble,
            turn.fromUser ? styles.userBubble : styles.agentBubble,
            turn.continues && (turn.fromUser ? styles.continuesUser : styles.continuesAgent),
          ),
          "text-body px-3.5 py-2 whitespace-pre-wrap",
        )}
      >
        {turn.body}
      </div>
      <time
        {...mergeStyleProps(
          stylex.props(styles.timestamp),
          "shrink-0 text-caption opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
        dateTime={new Date(turn.timestamp).toISOString()}
      >
        {formatTime(turn.timestamp)}
      </time>
    </div>
  );
}

// TODO(schema): Render canonical discriminated message parts directly once the SDK stops exposing
// provider-shaped ResponseItem content; entries that are not chat turns (reasoning, tool calls)
// only fall out here because they carry no role and no text.
function conversationTurns(entries: JuneSnapshot["messages"]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const body = messageText(entry.message.content);
    if (body.trim() === "") continue;
    const fromUser = role === "user";
    const previous = turns.at(-1);
    const opensDay = previous === undefined || !sameDay(previous.timestamp, entry.timestamp);
    turns.push({
      id: entry.id,
      body,
      fromUser,
      timestamp: entry.timestamp,
      // A day separator already breaks the run, so the joined corner would read as a lie.
      continues: !opensDay && previous?.fromUser === fromUser,
      opensDay,
    });
  }
  return turns;
}

function initial(name: string): string {
  return name.trim().charAt(0).toLocaleUpperCase() || "?";
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    timestamp,
  );
}

const dayInMs = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

// Separator labels are derived data rather than chrome copy, so today/yesterday come from
// Intl (localized, no hardcoded words) and older days fall back to an absolute date.
function dayLabel(timestamp: number): string {
  const days = Math.round((startOfDay(timestamp) - startOfDay(Date.now())) / dayInMs);
  if (days === 0 || days === -1) {
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      days,
      "day",
    );
    return relative.charAt(0).toLocaleUpperCase() + relative.slice(1);
  }
  if (new Date(timestamp).getFullYear() !== new Date().getFullYear()) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(timestamp);
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
