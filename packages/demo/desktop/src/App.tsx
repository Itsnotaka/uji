import { Button } from "@uji-ai/ui";
import type { SessionEvent, SessionId } from "@uji-ai/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentDraft, AgentId } from "./agents.ts";
import { AgentDetails, CreateAgentDialog } from "./components/agent-details.tsx";
import { ConversationWorkspace } from "./components/conversation-workspace.tsx";
import type { Notice } from "./components/notices.tsx";
import { SettingsDialog, type ThemePreference } from "./components/settings-dialog.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import type { OptimisticMessage } from "./components/transcript.tsx";
import type {
  LivePart,
  RuntimeSettingsChange,
  UjiDesktopEvent,
  UjiSnapshot,
} from "./desktop-api.ts";

interface LiveState {
  stopping: boolean;
  parts: readonly LivePart[];
}

type DeltaEvent = Extract<SessionEvent, { kind: "reasoning_delta" | "text_delta" }>;

type ReadyView = UjiSnapshot & {
  loading: boolean;
  notices: readonly Notice[];
  rendererLive: LiveState;
};

type AppState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: ReadyView };

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [pendingAction, setPendingAction] = useState<string>();
  const [draft, setDraft] = useState("");
  const [optimisticMessage, setOptimisticMessage] = useState<OptimisticMessage>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<ThemePreference>(readTheme);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [detailsWidth, setDetailsWidth] = useState(readDetailsWidth);
  const deltaBuffer = useRef(
    new Map<
      string,
      {
        part: Extract<LivePart, { kind: "text" | "thinking" }>;
        sessionId: SessionId;
      }
    >(),
  );
  const deltaFrame = useRef<number | undefined>(undefined);
  const noticeCount = useRef(0);
  const actionQueue = useRef<Promise<void>>(Promise.resolve());

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("uji.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("uji.sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("uji.sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("uji.details-width", String(detailsWidth));
  }, [detailsWidth]);

  useEffect(() => {
    let active = true;

    function cancelDeltaFrame(): void {
      if (deltaFrame.current !== undefined) cancelAnimationFrame(deltaFrame.current);
      deltaFrame.current = undefined;
      deltaBuffer.current.clear();
    }

    function flushDeltas(): void {
      deltaFrame.current = undefined;
      const buffered = deltaBuffer.current;
      deltaBuffer.current = new Map();
      if (!active) return;
      updateReady(setState, (view) => {
        const sessionId = view.activeSessionId;
        if (sessionId === null) return view;
        let parts = view.rendererLive.parts;
        for (const delta of buffered.values()) {
          if (delta.sessionId === sessionId) parts = appendLiveDelta(parts, delta.part);
        }
        if (parts === view.rendererLive.parts) return view;
        return {
          ...view,
          running: true,
          rendererLive: { ...view.rendererLive, parts },
        };
      });
    }

    function bufferDelta(sessionId: SessionId, event: DeltaEvent): void {
      const kind = event.kind === "text_delta" ? "text" : "thinking";
      const key = `${sessionId}:${kind}:${event.entryId}:${String(event.contentIndex)}`;
      const current = deltaBuffer.current.get(key);
      deltaBuffer.current.set(key, {
        sessionId,
        part: {
          kind,
          contentIndex: event.contentIndex,
          entryId: event.entryId,
          text: (current?.part.text ?? "") + event.delta,
        },
      });
      deltaFrame.current ??= requestAnimationFrame(flushDeltas);
    }

    function setSessionRunning(sessionId: SessionId, running: boolean): void {
      updateReady(setState, (view) => {
        const conversations = view.conversations.map((conversation) =>
          conversation.id === sessionId ? { ...conversation, running } : conversation,
        );
        if (view.activeSessionId !== sessionId) return { ...view, conversations };
        return {
          ...view,
          conversations,
          running,
          rendererLive: running
            ? { ...(view.running ? view.rendererLive : emptyLiveState()), stopping: false }
            : emptyLiveState(),
        };
      });
    }

    function handleEvent(event: UjiDesktopEvent): void {
      if (!active) return;
      switch (event.type) {
        case "session":
          switch (event.event.kind) {
            case "text_delta":
            case "reasoning_delta":
              bufferDelta(event.sessionId, event.event);
              return;
            case "tool_progress": {
              const part: LivePart = {
                kind: "tool",
                callId: event.event.callId,
                entryId: event.event.entryId,
                progress: event.event.progress,
              };
              updateReady(setState, (view) =>
                view.activeSessionId === event.sessionId
                  ? {
                      ...view,
                      rendererLive: {
                        ...view.rendererLive,
                        parts: upsertLivePart(view.rendererLive.parts, part),
                      },
                    }
                  : view,
              );
              return;
            }
            case "run_started":
              setSessionRunning(event.sessionId, true);
              return;
            case "run_finished":
              if (deltaFrame.current !== undefined) flushDeltas();
              setSessionRunning(event.sessionId, false);
              return;
            case "message": {
              const entryId = event.event.entryId;
              for (const [key, delta] of deltaBuffer.current) {
                if (delta.sessionId === event.sessionId && delta.part.entryId === entryId) {
                  deltaBuffer.current.delete(key);
                }
              }
              updateReady(setState, (view) =>
                view.activeSessionId === event.sessionId
                  ? {
                      ...view,
                      rendererLive: {
                        ...view.rendererLive,
                        parts: dropLiveEntry(view.rendererLive.parts, entryId),
                      },
                    }
                  : view,
              );
              return;
            }
            case "retry_scheduled":
            case "retry_started":
            case "compacting":
              setSessionRunning(event.sessionId, true);
              return;
            case "claim":
            case "compaction":
            case "diagnostic":
            case "head_moved":
            case "name_changed":
            case "plugins_changed":
            case "queue_cancelled":
            case "queue_consumed":
            case "queued":
            case "run_waiting":
            case "synced":
              return;
            default: {
              const exhaustive: never = event.event;
              return exhaustive;
            }
          }
        case "status":
          pushNotice(event.message, "info");
          return;
        case "error":
          updateReady(setState, (view) =>
            event.sessionId === undefined || event.sessionId === view.activeSessionId
              ? withNotice(view, makeNotice(event.message, "error"))
              : view,
          );
          return;
        case "snapshot":
          if (!event.snapshot.running) cancelDeltaFrame();
          setState((current) => ({
            kind: "ready",
            view: mergeSnapshot(
              current.kind === "ready" ? current.view : undefined,
              event.snapshot,
            ),
          }));
          if (!event.snapshot.running) setOptimisticMessage(undefined);
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

  useEffect(() => {
    function shortcut(event: KeyboardEvent): void {
      const dialogOpen = settingsOpen || createAgentOpen;
      if (event.key === "Escape" && !dialogOpen && state.kind === "ready" && state.view.running) {
        event.preventDefault();
        abort();
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (key === "k") {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>("#conversation-search");
        if (input !== null) input.focus();
        else {
          document.querySelector<HTMLButtonElement>("#conversation-search-trigger")?.click();
          requestAnimationFrame(() =>
            document.querySelector<HTMLInputElement>("#conversation-search")?.focus(),
          );
        }
        return;
      }
      if (key === "b") {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
        return;
      }
      if (key === "i" || key === "l") {
        event.preventDefault();
        focusComposer();
        return;
      }
      if (key === "n") {
        event.preventDefault();
        startNewChat();
        return;
      }
      const index = Number(key) - 1;
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        state.kind === "ready" &&
        state.view.conversations[index] !== undefined
      ) {
        event.preventDefault();
        selectConversation(state.view.conversations[index].id);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  function makeNotice(message: string, tone: Notice["tone"], action?: Notice["action"]): Notice {
    noticeCount.current += 1;
    return {
      id: `notice-${noticeCount.current}`,
      message,
      tone,
      ...(action === undefined ? {} : { action }),
    };
  }

  function pushNotice(message: string, tone: Notice["tone"], action?: Notice["action"]): void {
    const notice = makeNotice(message, tone, action);
    updateReady(setState, (view) => withNotice(view, notice));
    if (tone === "info") window.setTimeout(() => dismissNotice(notice.id), 4_000);
  }

  function dismissNotice(id: string): void {
    updateReady(setState, (view) => ({
      ...view,
      notices: view.notices.filter((notice) => notice.id !== id),
    }));
  }

  /**
   * Actions run one at a time so the host never interleaves session switches, but a queued click
   * is never dropped: the next action starts as soon as the previous one settles.
   */
  async function runAction(
    name: string,
    request: () => Promise<UjiSnapshot>,
    options: { closeDetails?: boolean; closeSettings?: boolean } = {},
  ): Promise<boolean> {
    const run = actionQueue.current.then(async () => {
      setPendingAction(name);
      try {
        const snapshot = await request();
        setState((current) => ({
          kind: "ready",
          view: mergeSnapshot(current.kind === "ready" ? current.view : undefined, snapshot),
        }));
        if (options.closeDetails === true) setDetailsOpen(false);
        if (options.closeSettings === true) setSettingsOpen(false);
        return true;
      } catch (error) {
        pushNotice(errorMessage(error), "error");
        return false;
      } finally {
        setPendingAction(undefined);
      }
    });
    actionQueue.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Pulls the host's view back after an optimistic switch failed. */
  function resync(): void {
    void window.uji
      .initialize()
      .then((snapshot) => {
        setState((current) => ({
          kind: "ready",
          view: mergeSnapshot(current.kind === "ready" ? current.view : undefined, snapshot),
        }));
      })
      .catch(() => undefined);
  }

  function selectAgent(agentId: AgentId): void {
    if (state.kind !== "ready" || state.view.activeAgentId === agentId) return;
    updateReady(setState, (view) => ({
      ...openingView(view),
      activeAgentId: agentId,
      activeSessionId: null,
    }));
    void runAction("select-agent", () => window.uji.selectAgent(agentId)).then((ok) => {
      if (!ok) resync();
    });
  }

  function selectConversation(sessionId: SessionId): void {
    if (state.kind !== "ready" || state.view.activeSessionId === sessionId) return;
    const target = state.view.conversations.find((conversation) => conversation.id === sessionId);
    if (target === undefined) return;
    // Stays not-running until the host answers, so mergeSnapshot adopts the host's live text
    // when the target conversation is mid-reply.
    updateReady(setState, (view) => ({
      ...openingView(view),
      activeAgentId: target.agentId,
      activeSessionId: sessionId,
    }));
    void runAction("select-conversation", () => window.uji.selectConversation(sessionId)).then(
      (ok) => {
        if (!ok) resync();
      },
    );
  }

  function startNewChat(agentId?: AgentId): void {
    if (state.kind !== "ready") return;
    const target = agentId ?? state.view.activeAgentId;
    if (target === null) return;
    setDraft("");
    updateReady(setState, (view) => ({
      ...openingView(view),
      activeAgentId: target,
      activeSessionId: null,
      loading: false,
    }));
    focusComposer();
    void runAction("new-chat", () => window.uji.newChat(target)).then((ok) => {
      if (!ok) resync();
    });
  }

  function login(): void {
    void runAction("login", () => window.uji.login()).then((ok) => {
      if (ok) focusComposer();
    });
  }

  function logout(): void {
    void runAction("logout", () => window.uji.logout());
  }

  function createAgent(agent: AgentDraft): void {
    void runAction("create-agent", async () => {
      const created = await window.uji.createAgent(agent);
      const agentId = created.activeAgentId;
      return agentId === null ? created : await window.uji.newChat(agentId);
    }).then((ok) => {
      if (!ok) return;
      setCreateAgentOpen(false);
      setDraft("");
      pushNotice(`${agent.name} is ready. Say hello.`, "info");
      focusComposer();
    });
  }

  function saveAgent(agentId: AgentId, changes: AgentDraft): void {
    void runAction("save-agent", () => window.uji.updateAgent(agentId, changes)).then((ok) => {
      if (ok) pushNotice(`Saved ${changes.name}.`, "info");
    });
  }

  function deleteAgent(agentId: AgentId): void {
    void runAction("delete-agent", () => window.uji.deleteAgent(agentId), {
      closeDetails: true,
    });
  }

  function renameConversation(sessionId: SessionId, name: string): void {
    void runAction("rename-conversation", () =>
      window.uji.renameConversation(sessionId, name),
    ).then((ok) => {
      if (ok) pushNotice("Chat renamed.", "info");
    });
  }

  function updateRuntime(change: RuntimeSettingsChange): void {
    void runAction("runtime", () => window.uji.updateRuntimeSettings(change));
  }

  async function sendMessage(body: string): Promise<void> {
    if (state.kind !== "ready") return;
    const text = body.trim();
    if (text === "" || state.view.activeAgentId === null) return;
    if (!state.view.auth.signedIn) {
      pushNotice("Connect ChatGPT before sending.", "error");
      return;
    }
    setDraft("");
    setOptimisticMessage({ body: text, id: `pending-${Date.now()}` });
    try {
      const snapshot = await window.uji.send(text);
      setState((current) => ({
        kind: "ready",
        view: mergeSnapshot(current.kind === "ready" ? current.view : undefined, snapshot),
      }));
      setOptimisticMessage(undefined);
    } catch (error) {
      setOptimisticMessage(undefined);
      setDraft((current) => (current === "" ? text : current));
      pushNotice(errorMessage(error), "error", {
        label: "Retry",
        run: () => void sendMessage(text),
      });
    }
  }

  function abort(): void {
    if (state.kind !== "ready" || !state.view.running || state.view.rendererLive.stopping) return;
    updateReady(setState, (view) => ({
      ...view,
      rendererLive: { ...view.rendererLive, stopping: true },
    }));
    void window.uji.abort().catch((error: unknown) => {
      updateReady(setState, (view) => ({
        ...view,
        rendererLive: { ...view.rendererLive, stopping: false },
      }));
      pushNotice(errorMessage(error), "error");
    });
  }

  function cancelQueued(entryId: string): void {
    void runAction("cancel-queued", () => window.uji.cancelQueued(entryId));
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
  const activeConversation = view.conversations.find(
    (conversation) => conversation.id === view.activeSessionId,
  );

  return (
    <div className="app-shell">
      <Sidebar
        accountLabel={view.auth.label}
        activeAgentId={view.activeAgentId}
        activeSessionId={view.activeSessionId}
        agents={view.agents}
        collapsed={sidebarCollapsed}
        conversations={view.conversations}
        onCreateAgent={() => setCreateAgentOpen(true)}
        onNewChat={startNewChat}
        onResize={setSidebarWidth}
        onSelectConversation={selectConversation}
        onSettings={() => setSettingsOpen(true)}
        query={query}
        setQuery={setQuery}
        signedIn={view.auth.signedIn}
        width={sidebarWidth}
      />

      <div className="workspace-stage" data-details-open={detailsOpen || undefined}>
        {activeAgent === undefined ? (
          <StatusScreen
            action="Create assistant"
            message="Create an assistant to start a Core-backed conversation."
            onAction={() => setCreateAgentOpen(true)}
          />
        ) : (
          <ConversationWorkspace
            agent={activeAgent}
            connecting={pendingAction === "login"}
            detailsOpen={detailsOpen}
            draft={draft}
            liveParts={view.rendererLive.parts}
            loading={view.loading}
            notices={view.notices}
            onAbort={abort}
            onCancelQueued={cancelQueued}
            onConnect={login}
            onDetails={() => setDetailsOpen((current) => !current)}
            onDismissNotice={dismissNotice}
            onDraftChange={setDraft}
            onNewChat={startNewChat}
            onRuntimeChange={updateRuntime}
            onSelectAgent={selectAgent}
            onSend={(message) => void sendMessage(message)}
            snapshot={view}
            stopping={view.rendererLive.stopping}
            waiting={pendingAction === "runtime"}
            {...(activeConversation === undefined ? {} : { conversation: activeConversation })}
            {...(optimisticMessage === undefined ? {} : { optimisticMessage })}
          />
        )}
        {detailsOpen && activeAgent !== undefined && (
          <AgentDetails
            agent={activeAgent}
            key={`${activeAgent.id}:${view.activeSessionId ?? "new"}`}
            onClose={() => setDetailsOpen(false)}
            onDelete={() => deleteAgent(activeAgent.id)}
            onRenameConversation={(name) => {
              if (view.activeSessionId !== null) renameConversation(view.activeSessionId, name);
            }}
            onResize={setDetailsWidth}
            onSave={(changes) => saveAgent(activeAgent.id, changes)}
            pending={pendingAction === "save-agent" || pendingAction === "delete-agent"}
            snapshot={view}
            width={detailsWidth}
            {...(activeConversation === undefined ? {} : { conversation: activeConversation })}
          />
        )}
      </div>

      {settingsOpen && (
        <SettingsDialog
          onLogin={login}
          onLogout={logout}
          onOpenChange={setSettingsOpen}
          onRuntimeChange={updateRuntime}
          onThemeChange={setTheme}
          open
          pendingAction={pendingAction}
          snapshot={view}
          theme={theme}
        />
      )}
      {createAgentOpen && (
        <CreateAgentDialog
          onCreate={createAgent}
          onOpenChange={setCreateAgentOpen}
          open
          pending={pendingAction === "create-agent"}
        />
      )}
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="loading-shell">
      <strong>Uji</strong>
      <span aria-label="Loading" className="loading-dot" role="status" />
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
      <span className="status-mark">U</span>
      <h1>Uji</h1>
      <p>{message}</p>
      <Button onClick={onAction}>{action}</Button>
    </main>
  );
}

function focusComposer(): void {
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>("#message-composer")?.focus(),
  );
}

function emptyLiveState(): LiveState {
  return { stopping: false, parts: [] };
}

/** Clears the transcript while the host opens another session, so switching feels immediate. */
function openingView(view: ReadyView): ReadyView {
  return {
    ...view,
    context: null,
    loading: true,
    messages: [],
    pending: [],
    rendererLive: emptyLiveState(),
    running: false,
  };
}

function withNotice(view: ReadyView, notice: Notice): ReadyView {
  const kept = view.notices.filter((current) => current.message !== notice.message);
  return { ...view, notices: [...kept, notice].slice(-3) };
}

function toReadyView(snapshot: UjiSnapshot): ReadyView {
  return { ...snapshot, loading: false, notices: [], rendererLive: toLiveState(snapshot.live) };
}

function mergeSnapshot(current: ReadyView | undefined, snapshot: UjiSnapshot): ReadyView {
  const sameRunningSession =
    snapshot.running &&
    current?.running === true &&
    current.activeSessionId === snapshot.activeSessionId;
  return {
    ...snapshot,
    loading: false,
    notices: current?.notices ?? [],
    rendererLive: sameRunningSession ? current.rendererLive : toLiveState(snapshot.live),
  };
}

function toLiveState(live: UjiSnapshot["live"]): LiveState {
  return { stopping: false, parts: live.parts };
}

function appendLiveDelta(
  parts: readonly LivePart[],
  delta: Extract<LivePart, { kind: "text" | "thinking" }>,
): readonly LivePart[] {
  const index = parts.findIndex(
    (part) =>
      part.kind === delta.kind &&
      part.entryId === delta.entryId &&
      part.contentIndex === delta.contentIndex,
  );
  if (index < 0) return [...parts, delta];
  const current = parts[index];
  if (current?.kind !== delta.kind) return parts;
  return parts.with(index, { ...delta, text: current.text + delta.text });
}

function upsertLivePart(parts: readonly LivePart[], next: LivePart): readonly LivePart[] {
  const index = parts.findIndex((part) =>
    next.kind === "tool" && part.kind === "tool"
      ? part.callId === next.callId
      : next.kind !== "tool" &&
        part.kind === next.kind &&
        part.entryId === next.entryId &&
        part.contentIndex === next.contentIndex,
  );
  return index < 0 ? [...parts, next] : parts.with(index, next);
}

function dropLiveEntry(parts: readonly LivePart[], entryId: string): readonly LivePart[] {
  return parts.filter((part) => part.entryId !== entryId);
}

function updateReady(
  setState: (update: (current: AppState) => AppState) => void,
  update: (view: ReadyView) => ReadyView,
): void {
  setState((current) =>
    current.kind === "ready" ? { kind: "ready", view: update(current.view) } : current,
  );
}

function readTheme(): ThemePreference {
  const value = localStorage.getItem("uji.theme");
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function readSidebarWidth(): number {
  const stored = localStorage.getItem("uji.sidebar-width");
  if (stored === null) return 300;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(400, Math.max(240, value)) : 280;
}

function readSidebarCollapsed(): boolean {
  return localStorage.getItem("uji.sidebar-collapsed") === "true";
}

function readDetailsWidth(): number {
  const stored = localStorage.getItem("uji.details-width");
  if (stored === null) return 320;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(480, Math.max(280, value)) : 320;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
