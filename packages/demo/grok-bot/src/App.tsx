import { useState, useSyncExternalStore } from "react";

import { Button } from "@june/ui";
import { agentById, type AgentId } from "@/agents";
import { AgentCreateDialog } from "@/components/agent-dialogs";
import { BotDetails } from "@/components/bot-details";
import { Conversation } from "@/components/conversation";
import { SearchPalette } from "@/components/search-palette";
import { Sidebar } from "@/components/sidebar";
import { useJuneViewQuery } from "@/hooks/use-june-view-query";
import { useNewChat } from "@/hooks/use-new-chat";
import { useSelectAgent } from "@/hooks/use-select-agent";
import { errorMessage, type JuneView } from "@/june-view";
import { strings } from "@/strings";
import { applyThemePreference, loadThemePreference, type ThemePreference } from "@/theme";

const defaultSidebarWidth = 280;
const collapsedSidebarWidth = 88;
const minimumConversationWidth = 424;
const defaultDetailsWidth = 320;

function subscribeToWindowResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

export function App() {
  const viewQuery = useJuneViewQuery();

  if (viewQuery.isPending) {
    return <div className="bg-background h-full" />;
  }
  if (viewQuery.isError) {
    return (
      <div className="bg-background text-foreground grid h-full place-items-center">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-label text-muted-foreground">{errorMessage(viewQuery.error)}</p>
          <Button onClick={() => void viewQuery.refetch()} size="sm" variant="outline">
            {strings.app.retry}
          </Button>
        </div>
      </div>
    );
  }
  return <Workspace view={viewQuery.data} />;
}

function Workspace({ view }: { view: JuneView }) {
  const selectAgent = useSelectAgent();
  const newChat = useNewChat();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const [detailsWidth, setDetailsWidth] = useState(defaultDetailsWidth);
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const windowWidth = useSyncExternalStore(subscribeToWindowResize, () => window.innerWidth);

  const selectedId = view.activeAgentId;
  const activeAgent = selectedId === null ? undefined : agentById(selectedId, view.agents);
  const switching = selectAgent.isPending || newChat.isPending;
  const running = view.running;

  const sidebarCollapsed =
    windowWidth < sidebarWidth + minimumConversationWidth + (detailsOpen ? detailsWidth : 0);
  const visibleSidebarWidth = sidebarCollapsed ? collapsedSidebarWidth : sidebarWidth;
  const detailsOverlay =
    windowWidth - visibleSidebarWidth < minimumConversationWidth + detailsWidth;

  function selectAgentById(id: AgentId, onSelected?: () => void) {
    if (id === selectedId) {
      onSelected?.();
      return;
    }
    if (running || switching) return;
    selectAgent.mutate(id, { onSuccess: onSelected });
  }

  function startChat(id: AgentId | null) {
    if (id === null || running || switching) return;
    newChat.mutate(id);
  }

  function changeTheme(preference: ThemePreference) {
    applyThemePreference(preference);
    setTheme(preference);
  }

  return (
    <div
      className="bg-background text-foreground grid h-full min-h-0 font-sans"
      style={{ gridTemplateColumns: `${visibleSidebarWidth}px minmax(0, 1fr)` }}
    >
      <Sidebar
        agents={view.agents}
        auth={view.auth}
        collapsed={sidebarCollapsed}
        previews={view.agentPreviews}
        onEdit={(id) => selectAgentById(id, () => setDetailsOpen(true))}
        onNewChat={startChat}
        onResize={(width) => setSidebarWidth(Math.min(400, Math.max(240, width)))}
        onSelect={selectAgentById}
        onThemeChange={changeTheme}
        running={running || switching}
        selectedId={selectedId}
        themePreference={theme}
      />
      <main className="bg-background relative flex min-w-0">
        {activeAgent === undefined ? (
          <EmptyWorkspace />
        ) : (
          <>
            <Conversation
              agent={activeAgent}
              auth={view.auth}
              initializing={switching}
              key={activeAgent.id}
              messages={view.messages}
              notice={view.notice}
              onOpenDetails={() => setDetailsOpen(true)}
              running={running}
              streamingText={view.streamingText}
            />
            {detailsOpen && (
              <BotDetails
                agent={activeAgent}
                key={activeAgent.id}
                onClose={() => setDetailsOpen(false)}
                onResize={(width) => setDetailsWidth(Math.min(480, Math.max(280, width)))}
                overlay={detailsOverlay}
                width={detailsWidth}
              />
            )}
          </>
        )}
      </main>
      <SearchPalette
        agents={view.agents}
        onEdit={(id) => selectAgentById(id, () => setDetailsOpen(true))}
        onNewChat={startChat}
        onSelect={selectAgentById}
        running={running || switching}
        selectedId={selectedId}
      />
    </div>
  );
}

function EmptyWorkspace() {
  return (
    <section className="grid flex-1 place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-title font-medium">{strings.onboarding.createFirstTitle}</h1>
        <p className="text-label text-muted-foreground">{strings.onboarding.createFirstBody}</p>
        <AgentCreateDialog
          trigger={<Button size="sm">{strings.onboarding.createFirstCta}</Button>}
        />
      </div>
    </section>
  );
}
