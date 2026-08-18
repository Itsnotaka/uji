import { useEffect, useRef, useState, type FormEvent } from "react";

import { BotDetails } from "@/components/bot-details";
import { Conversation } from "@/components/conversation";
import { SearchPalette } from "@/components/search-palette";
import { Sidebar } from "@/components/sidebar";
import { agents as defaultAgents, june, type Agent, type AgentId } from "@/demo-data";
import type { AuthStatus, JuneSnapshot } from "@/desktop-api";

const signedOut: AuthStatus = { signedIn: false, label: "ChatGPT not connected" };
const defaultSidebarWidth = 280;
const collapsedSidebarWidth = 88;
const minimumConversationWidth = 424;
const defaultDetailsWidth = 320;

export function App() {
  const [agents, setAgents] = useState<Agent[]>(() => defaultAgents.map((agent) => ({ ...agent })));
  const [selectedId, setSelectedId] = useState<AgentId>(june.id);
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [detailsWidth, setDetailsWidth] = useState(defaultDetailsWidth);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Record<AgentId, JuneSnapshot["messages"]>>(() => ({
    june: [],
    tweeter: [],
    slacker: [],
    rawr: [],
  }));
  const [previews, setPreviews] = useState<Record<AgentId, string>>(
    () =>
      Object.fromEntries(agents.map((agent) => [agent.id, "No messages yet"])) as Record<
        AgentId,
        string
      >,
  );
  const [auth, setAuth] = useState<AuthStatus>(signedOut);
  const [initializing, setInitializing] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [notice, setNotice] = useState<string>();

  function applySnapshot(snapshot: JuneSnapshot) {
    setSelectedId(snapshot.activeAgentId);
    setAgents(snapshot.agents);
    setAuth(snapshot.auth);
    setRunning(snapshot.running);
    setStreamingText("");
    setMessages((current) => ({ ...current, [snapshot.activeAgentId]: snapshot.messages }));
    setPreviews(snapshot.agentPreviews);
    if (snapshot.auth.signedIn) setNotice(undefined);
  }

  useEffect(() => {
    const unsubscribe = window.june.onEvent((event) => {
      switch (event.type) {
        case "delta":
          setStreamingText((current) => current + event.text);
          return;
        case "running":
          setRunning(event.running);
          if (event.running) setStreamingText("");
          return;
        case "status":
        case "error":
          setNotice(event.message);
          return;
        case "snapshot":
          applySnapshot(event.snapshot);
          return;
      }
    });

    void window.june
      .initialize()
      .then(applySnapshot)
      .catch((error: unknown) => setNotice(errorMessage(error)))
      .finally(() => setInitializing(false));
    return unsubscribe;
  }, []);

  useEffect(() => {
    function measureWindow() {
      setWindowWidth(window.innerWidth);
    }

    window.addEventListener("resize", measureWindow);
    return () => window.removeEventListener("resize", measureWindow);
  }, []);

  useEffect(() => {
    function openCommands(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((current) => !current);
      }
    }

    window.addEventListener("keydown", openCommands);
    return () => window.removeEventListener("keydown", openCommands);
  }, []);

  const activeAgent = agents.find((agent) => agent.id === selectedId) ?? june;
  const sidebarCollapsed =
    windowWidth < sidebarWidth + minimumConversationWidth + (detailsOpen ? detailsWidth : 0);
  const visibleSidebarWidth = sidebarCollapsed ? collapsedSidebarWidth : sidebarWidth;
  const detailsOverlay =
    windowWidth - visibleSidebarWidth < minimumConversationWidth + detailsWidth;

  async function selectAgent(id: AgentId): Promise<boolean> {
    if (id === selectedId) return true;
    if (running || switchingRef.current) return false;
    switchingRef.current = true;
    setSwitching(true);
    setNotice(undefined);
    setDraft("");
    setStreamingText("");
    try {
      applySnapshot(await window.june.selectAgent(id));
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }

  async function newChat(id: AgentId = selectedId) {
    setNotice(undefined);
    if (running || switchingRef.current) return;
    switchingRef.current = true;
    setSwitching(true);
    setDraft("");
    try {
      applySnapshot(await window.june.newChat(id));
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }

  async function editAgent(id: AgentId) {
    if (!(await selectAgent(id))) return;
    setDetailsOpen(true);
  }

  async function login() {
    setSigningIn(true);
    setNotice("Finish signing in in your browser.");
    try {
      applySnapshot(await window.june.login());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setSigningIn(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || running) return;

    const message: JuneSnapshot["messages"][number] = {
      type: "message",
      id: `${selectedId}-${Date.now()}`,
      seq: Number.MAX_SAFE_INTEGER,
      parentId: null,
      timestamp: Date.now(),
      message: { role: "user", content: body },
    };
    setMessages((current) => ({
      ...current,
      [selectedId]: [...current[selectedId], message],
    }));
    setPreviews((current) => ({ ...current, [selectedId]: body }));
    setDraft("");
    setNotice(undefined);

    try {
      applySnapshot(await window.june.send(body));
    } catch (error) {
      setNotice(errorMessage(error));
      try {
        applySnapshot(await window.june.initialize());
      } catch {
        // Keep the send error visible.
      }
    }
  }

  async function saveAgent(changes: Pick<Agent, "name" | "role" | "instructions">) {
    applySnapshot(await window.june.updateAgent(selectedId, changes));
  }

  return (
    <div
      className="grid h-full min-h-0 bg-background font-sans text-foreground"
      data-grok-surface="shell"
      style={{ gridTemplateColumns: `${visibleSidebarWidth}px minmax(0, 1fr)` }}
    >
      <Sidebar
        agents={agents}
        auth={auth}
        collapsed={sidebarCollapsed}
        previews={previews}
        onEdit={(id) => void editAgent(id)}
        onLogin={() => void login()}
        onNewChat={(id) => void newChat(id)}
        onOpenSearch={() => setSearchOpen(true)}
        onResize={(width) => setSidebarWidth(Math.min(400, Math.max(240, width)))}
        onSelect={(id) => void selectAgent(id)}
        running={running || switching}
        selectedId={selectedId}
        signingIn={signingIn}
      />
      <main className="relative flex min-w-0 bg-background" data-grok-surface="canvas">
        <Conversation
          agent={activeAgent}
          auth={auth}
          draft={draft}
          initializing={initializing || switching}
          messages={messages[selectedId] ?? []}
          notice={notice}
          onDraftChange={setDraft}
          onLogin={() => void login()}
          onOpenDetails={() => setDetailsOpen(true)}
          onSend={(event) => void sendMessage(event)}
          onStop={() => void window.june.abort()}
          running={running}
          signingIn={signingIn}
          streamingText={streamingText}
        />
        {detailsOpen && (
          <BotDetails
            agent={activeAgent}
            onResize={(width) => setDetailsWidth(Math.min(480, Math.max(280, width)))}
            onClose={() => setDetailsOpen(false)}
            onSave={saveAgent}
            overlay={detailsOverlay}
            width={detailsWidth}
          />
        )}
      </main>
      <SearchPalette
        agents={agents}
        onClose={() => setSearchOpen(false)}
        onEdit={(id) => void editAgent(id)}
        onNewChat={(id) => void newChat(id)}
        onSelect={(id) => void selectAgent(id)}
        open={searchOpen}
        running={running || switching}
        selectedId={selectedId}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
