import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import type { Agent, AgentId } from "./agents.ts";
import type { UjiDesktopEvent, UjiSnapshot } from "./desktop-api.ts";
import { messageText } from "./messages.ts";

type ReadyView = UjiSnapshot & {
  notice?: string;
  streamingText: string;
};

type AppState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: ReadyView };

type PendingAction = "login" | "new-chat" | "select" | "send";

type OptimisticMessage = {
  body: string;
  id: string;
  timestamp: number;
};

type Turn = OptimisticMessage & {
  fromUser: boolean;
};

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [pending, setPending] = useState<PendingAction>();
  const [draft, setDraft] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticMessage>();
  const deltaBuffer = useRef("");
  const deltaFrame = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;

    function cancelDeltaFrame(): void {
      if (deltaFrame.current !== undefined) cancelAnimationFrame(deltaFrame.current);
      deltaFrame.current = undefined;
      deltaBuffer.current = "";
    }

    function flushDeltas(): void {
      deltaFrame.current = undefined;
      const text = deltaBuffer.current;
      deltaBuffer.current = "";
      if (text === "" || !active) return;
      updateReady(setState, (view) => ({
        ...view,
        running: true,
        streamingText: view.streamingText + text,
      }));
    }

    function handleEvent(event: UjiDesktopEvent): void {
      if (!active) return;
      switch (event.type) {
        case "delta":
          deltaBuffer.current += event.text;
          if (deltaFrame.current === undefined) {
            deltaFrame.current = requestAnimationFrame(flushDeltas);
          }
          return;
        case "running":
          if (!event.running && deltaFrame.current !== undefined) {
            cancelAnimationFrame(deltaFrame.current);
            flushDeltas();
          }
          updateReady(setState, (view) => ({
            ...view,
            running: event.running,
            streamingText: event.running && !view.running ? "" : view.streamingText,
          }));
          return;
        case "status":
        case "error":
          updateReady(setState, (view) => ({ ...view, notice: event.message }));
          return;
        case "snapshot":
          cancelDeltaFrame();
          setOptimisticMessage(undefined);
          setState({ kind: "ready", view: toReadyView(event.snapshot) });
          return;
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    }

    const unsubscribe = window.uji.onEvent(handleEvent);
    void window.uji
      .initialize()
      .then((snapshot) => {
        if (active) setState({ kind: "ready", view: toReadyView(snapshot) });
      })
      .catch((error: unknown) => {
        if (active) setState({ kind: "error", message: errorMessage(error) });
      });

    return () => {
      active = false;
      cancelDeltaFrame();
      unsubscribe();
    };
  }, []);

  async function runAction(
    action: Exclude<PendingAction, "send">,
    request: () => Promise<UjiSnapshot>,
  ): Promise<void> {
    setPending(action);
    clearNotice(setState);
    try {
      const snapshot = await request();
      setState({ kind: "ready", view: toReadyView(snapshot) });
    } catch (error) {
      setNotice(setState, errorMessage(error));
    }
    setPending(undefined);
  }

  function selectAgent(agentId: AgentId): void {
    if (state.kind !== "ready") return;
    if (state.view.activeAgentId === agentId || state.view.running || pending !== undefined) return;
    void runAction("select", () => window.uji.selectAgent(agentId));
  }

  function startNewChat(): void {
    if (state.kind !== "ready") return;
    const agentId = state.view.activeAgentId;
    if (agentId === null || state.view.running || pending !== undefined) return;
    void runAction("new-chat", () => window.uji.newChat(agentId));
  }

  function login(): void {
    if (pending !== undefined) return;
    void runAction("login", () => window.uji.login());
  }

  function abort(): void {
    void window.uji.abort().catch((error: unknown) => setNotice(setState, errorMessage(error)));
  }

  async function sendMessage(body: string): Promise<void> {
    if (state.kind !== "ready" || pending !== undefined) return;
    const text = body.trim();
    if (text === "" || state.view.activeAgentId === null || !state.view.auth.signedIn) return;

    const message = { body: text, id: `pending-${Date.now()}`, timestamp: Date.now() };
    setDraft("");
    setOptimisticMessage(message);
    setPending("send");
    clearNotice(setState);
    try {
      const snapshot = await window.uji.send(text);
      setState({ kind: "ready", view: toReadyView(snapshot) });
    } catch (error) {
      setDraft(text);
      setNotice(setState, errorMessage(error));
    }
    setOptimisticMessage(undefined);
    setPending(undefined);
  }

  if (state.kind === "loading") return <LoadingScreen />;
  if (state.kind === "error") {
    return (
      <StatusScreen
        action="Try again"
        message={state.message}
        onAction={() => window.location.reload()}
      />
    );
  }

  const view = state.view;
  const activeAgent = view.agents.find((agent) => agent.id === view.activeAgentId);
  const busy = pending !== undefined;

  return (
    <div className="app-shell">
      <Titlebar
        activeAgentId={view.activeAgentId}
        agents={view.agents}
        disabled={view.running || busy}
        onNewChat={startNewChat}
        onSelect={selectAgent}
      />

      {activeAgent === undefined ? (
        <StatusMessage message="No assistants are available." />
      ) : (
        <Conversation
          agent={activeAgent}
          draft={draft}
          messages={view.messages}
          notice={view.notice}
          onAbort={abort}
          onDraftChange={setDraft}
          onLogin={login}
          onSend={(body) => void sendMessage(body)}
          optimisticMessage={optimisticMessage}
          pending={pending}
          running={view.running}
          signedIn={view.auth.signedIn}
          streamingText={view.streamingText}
        />
      )}
    </div>
  );
}

function Titlebar({
  activeAgentId,
  agents,
  disabled,
  onNewChat,
  onSelect,
}: {
  activeAgentId: AgentId | null;
  agents: readonly Agent[];
  disabled: boolean;
  onNewChat: () => void;
  onSelect: (agentId: AgentId) => void;
}) {
  return (
    <header className="titlebar">
      <strong className="wordmark">Uji</strong>
      <nav aria-label="Assistants" className="agent-strip">
        {agents.map((agent) => (
          <button
            aria-pressed={agent.id === activeAgentId}
            className="agent-option"
            disabled={disabled && agent.id !== activeAgentId}
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            type="button"
          >
            <AgentAvatar agent={agent} />
            <span>{agent.name}</span>
          </button>
        ))}
      </nav>
      {activeAgentId !== null && (
        <button
          aria-label="New chat"
          className="icon-button new-chat"
          disabled={disabled}
          onClick={onNewChat}
          title="New chat"
          type="button"
        >
          <PlusIcon />
        </button>
      )}
    </header>
  );
}

function Conversation({
  agent,
  draft,
  messages,
  notice,
  optimisticMessage,
  pending,
  running,
  signedIn,
  streamingText,
  onAbort,
  onDraftChange,
  onLogin,
  onSend,
}: {
  agent: Agent;
  draft: string;
  messages: UjiSnapshot["messages"];
  notice?: string;
  optimisticMessage?: OptimisticMessage;
  pending?: PendingAction;
  running: boolean;
  signedIn: boolean;
  streamingText: string;
  onAbort: () => void;
  onDraftChange: (draft: string) => void;
  onLogin: () => void;
  onSend: (body: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const turns = toTurns(messages, optimisticMessage);
  const streaming = running || streamingText !== "";

  useLayoutEffect(() => {
    if (!pinned.current) return;
    const node = scroller.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [turns.length, streamingText]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSend(draft);
    pinned.current = true;
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  const canSend = signedIn && !running && pending === undefined && draft.trim() !== "";

  return (
    <main className="conversation">
      <div
        className="messages"
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
        }}
        ref={scroller}
      >
        <div aria-label={`Conversation with ${agent.name}`} className="message-column" role="log">
          {turns.length === 0 && !streaming ? (
            <div className="empty-chat">
              <AgentAvatar agent={agent} large />
              <h1>{agent.name}</h1>
              {agent.role !== "" && <p>{agent.role}</p>}
            </div>
          ) : (
            turns.map((turn) => <Message key={turn.id} turn={turn} />)
          )}
          {streaming && (
            <div className="message assistant-message streaming-message">
              <AgentAvatar agent={agent} />
              <div className="message-body">
                {streamingText === "" ? <TypingIndicator /> : streamingText}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="composer-dock">
        <div className="composer-column">
          {notice !== undefined && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {!signedIn && (
            <button
              className="connect-button"
              disabled={pending !== undefined}
              onClick={onLogin}
              type="button"
            >
              {pending === "login" ? "Waiting for browser…" : "Connect ChatGPT to start"}
            </button>
          )}
          <form className="composer" onSubmit={submit}>
            <textarea
              aria-label={`Message ${agent.name}`}
              autoFocus
              disabled={!signedIn || running || pending !== undefined}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={submitOnEnter}
              placeholder={signedIn ? `Message ${agent.name}` : "Connect ChatGPT to send a message"}
              rows={1}
              value={draft}
            />
            {running ? (
              <button
                aria-label="Stop response"
                className="composer-action stop-button"
                onClick={onAbort}
                type="button"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                aria-label="Send message"
                className="composer-action send-button"
                disabled={!canSend}
                type="submit"
              >
                <ArrowIcon />
              </button>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}

function Message({ turn }: { turn: Turn }) {
  return (
    <div className={`message ${turn.fromUser ? "user-message" : "assistant-message"}`}>
      {!turn.fromUser && <span className="assistant-mark">U</span>}
      <div className="message-body">{turn.body}</div>
    </div>
  );
}

function AgentAvatar({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return (
    <span
      className={large ? "agent-avatar agent-avatar-large" : "agent-avatar"}
      data-tone={agent.avatar}
    >
      {agent.name.trim().charAt(0).toLocaleUpperCase() || "?"}
    </span>
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

function LoadingScreen() {
  return (
    <div className="app-shell">
      <header className="titlebar">
        <strong className="wordmark">Uji</strong>
      </header>
      <div className="status-screen" role="status">
        <span className="loading-dot" />
      </div>
    </div>
  );
}

function StatusScreen({
  action,
  message,
  onAction,
}: {
  action: string;
  message: string;
  onAction: () => void;
}) {
  return (
    <main className="status-screen">
      <p>{message}</p>
      <button className="primary-button" onClick={onAction} type="button">
        {action}
      </button>
    </main>
  );
}

function StatusMessage({ message }: { message: string }) {
  return (
    <main className="status-screen">
      <p>{message}</p>
    </main>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m4 8 4-4 4 4M8 4v8" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect height="7" rx="1.5" width="7" x="4.5" y="4.5" />
    </svg>
  );
}

function toTurns(
  entries: UjiSnapshot["messages"],
  optimisticMessage: OptimisticMessage | undefined,
): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const body = messageText(entry.message.content).trim();
    if (body === "") continue;
    turns.push({ id: entry.id, body, timestamp: entry.timestamp, fromUser: role === "user" });
  }
  if (optimisticMessage !== undefined) turns.push({ ...optimisticMessage, fromUser: true });
  return turns;
}

function toReadyView(snapshot: UjiSnapshot): ReadyView {
  return { ...snapshot, streamingText: "" };
}

function updateReady(
  setState: (update: (current: AppState) => AppState) => void,
  update: (view: ReadyView) => ReadyView,
): void {
  setState((current) =>
    current.kind === "ready" ? { kind: "ready", view: update(current.view) } : current,
  );
}

function clearNotice(setState: (update: (current: AppState) => AppState) => void): void {
  updateReady(setState, (view) => ({ ...view, notice: undefined }));
}

function setNotice(
  setState: (update: (current: AppState) => AppState) => void,
  notice: string,
): void {
  updateReady(setState, (view) => ({ ...view, notice }));
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
