/**
 * One mounted shell — titlebar, rail, stage — around one workspace-lifetime
 * pane stage. There is no separate home screen: with no workspace open the
 * stage shows the blank pane's "open a folder" state and the rail lists recent
 * projects, so opening a project never swaps the surface. Memory history fits
 * an Electron window with no URL bar. The shell also owns the app-wide keys —
 * ⌘N and ⌘[ return to the blank pane, ⌘B shows or hides the rail, ⌘, opens
 * Settings, ⌘D and ⇧⌘D split the stage — because the renderer owns chords.
 */
import * as stylex from "@stylexjs/stylex";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactElement } from "react";
import { SettingsDialogHost } from "./chrome/appearance-settings.tsx";
import { WorkspaceDialogHost } from "./chrome/open-workspace.tsx";
import { shellActions } from "./chrome/shell-state.ts";
import { SidebarPane } from "./chrome/sidebar-pane.tsx";
import { Sidebar } from "./chrome/sidebar.tsx";
import { Titlebar } from "./chrome/titlebar.tsx";
import {
  PaneControllerProvider,
  usePaneActions,
  usePaneControllerSnapshot,
} from "./layout/pane-context.tsx";
import { keys, queryClient, useHostState, warmThread } from "./queries.ts";
import { getStartupDestination, startupSession } from "./startup-preference.ts";
import { WorkspaceStage } from "./shell/workspace-stage.tsx";
import { t } from "./theme/vars.stylex.ts";
import { asSessionId, uji } from "./uji.ts";

const styles = stylex.create({
  shell: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: t.bgSubtle,
  },
  stage: {
    display: "flex",
    flex: 1,
    minHeight: 0,
  },
  surface: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: t.bgBase,
    overflow: "hidden",
  },
});

function Shell(): ReactElement {
  const host = useHostState();

  return (
    <PaneControllerProvider workspaceKey={host.data?.workspace?.path}>
      <ShellChrome />
    </PaneControllerProvider>
  );
}

function ShellChrome(): ReactElement {
  const host = useHostState();
  const shellRouter = useRouter();
  const panes = usePaneActions();
  const { layout } = usePaneControllerSnapshot();
  const canSplit = layout.kind === "single";
  const platform = host.data?.platform;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        platform === undefined ||
        !(platform === "darwin" ? event.metaKey : event.ctrlKey) ||
        event.altKey
      )
        return;
      const key = event.key.toLocaleLowerCase();
      if (key === "d") {
        if (!canSplit) return;
        event.preventDefault();
        panes.split(event.shiftKey ? "down" : "right");
        return;
      }
      if (event.shiftKey) return;
      if (key === "n" || (key === "[" && shellRouter.state.location.pathname !== "/")) {
        event.preventDefault();
        panes.newChat();
      } else if (key === "b") {
        event.preventDefault();
        shellActions.toggleSidebar();
      } else if (key === ",") {
        event.preventDefault();
        shellActions.openSettings("general");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [canSplit, panes, platform, shellRouter]);

  return (
    <div data-uji-shell {...stylex.props(styles.shell)}>
      <Titlebar />
      <div {...stylex.props(styles.stage)}>
        <SidebarPane>
          <Sidebar />
        </SidebarPane>
        <main {...stylex.props(styles.surface)}>
          <Outlet />
        </main>
      </div>
      <WorkspaceDialogHost />
      <SettingsDialogHost />
    </div>
  );
}

export const rootRoute = createRootRoute({ component: Shell });

async function readRouteHost() {
  const host = await uji.host.state();
  queryClient.setQueryData(keys.host, host);
  return host;
}

/**
 * The stage route. `workspace` is undefined until a folder opens; the stage
 * stays mounted either way and only its data binding changes.
 */
export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_workspace",
  beforeLoad: async () => {
    const host = await readRouteHost();
    return { workspace: host.workspace };
  },
  component: WorkspaceStage,
});

let startupDestinationPending = true;

export const indexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    if (!startupDestinationPending) return;
    startupDestinationPending = false;
    if (getStartupDestination() === "new-chat" || context.workspace === undefined) return;

    const sessions = await uji.sessions.list({ limit: 1 });
    const sessionId = startupSession("last-session", sessions.items);
    if (sessionId !== undefined) {
      throw redirect({
        to: threadRoute.to,
        params: { sessionId },
        replace: true,
      });
    }
  },
});

export const threadRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/session/$sessionId",
  params: {
    parse: ({ sessionId }) => ({ sessionId: asSessionId(sessionId) }),
    stringify: ({ sessionId }) => ({ sessionId }),
  },
  beforeLoad: async ({ params }) => {
    const session = await uji.sessions.get({ sessionId: params.sessionId });
    queryClient.setQueryData(keys.session(params.sessionId), session ?? null);
    if (session === undefined) throw redirect({ to: indexRoute.to, replace: true });
  },
  // Route intent and navigation both warm the coherent snapshot. The loader
  // deliberately returns now: local data may finish later and never gates the
  // pending route commit.
  loader: ({ params }) => warmThread(params.sessionId),
});

const workspaceRouteTree = workspaceRoute.addChildren([indexRoute, threadRoute]);
const routeTree = rootRoute.addChildren([workspaceRouteTree]);
const history = createMemoryHistory({ initialEntries: ["/"] });

export const router = createRouter({
  routeTree,
  history,
  defaultPreload: "intent",
  defaultPreloadDelay: 50,
  defaultStructuralSharing: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
