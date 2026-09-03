import type { SessionId } from "@uji-ai/core";
import { useRouter } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";
import { PaneController } from "./pane-controller.ts";
import type { PaneControllerSnapshot } from "./pane-controller.ts";
import { activeSelection } from "./pane-layout.ts";
import type {
  DropPlacement,
  PaneId,
  PaneLayout,
  PaneSelection,
  SplitDirection,
} from "./pane-layout.ts";
import type { SessionViewStateStore } from "./session-view-state.ts";

const controllerCache = new Map<string, PaneController>();
const PaneControllerContext = createContext<PaneController | undefined>(undefined);

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function controllerForWorkspace(workspaceKey: string): PaneController {
  const existing = controllerCache.get(workspaceKey);
  if (existing !== undefined) return existing;
  const controller = new PaneController({
    storage: browserStorage(),
    storageKey: `uji.desktop.panes.v1:${workspaceKey}`,
  });
  controllerCache.set(workspaceKey, controller);
  return controller;
}

export function PaneControllerProvider({
  workspaceKey,
  children,
}: {
  workspaceKey: string | undefined;
  children: ReactNode;
}): ReactElement {
  const controller = useMemo(
    () => controllerForWorkspace(workspaceKey ?? "no-workspace"),
    [workspaceKey],
  );
  return (
    <PaneControllerContext.Provider value={controller}>{children}</PaneControllerContext.Provider>
  );
}

function useController(): PaneController {
  const controller = useContext(PaneControllerContext);
  if (controller === undefined) throw new Error("Pane controller is missing");
  return controller;
}

export function usePaneControllerSnapshot(): PaneControllerSnapshot {
  const controller = useController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function usePaneViewStateStore(): SessionViewStateStore {
  return useController().viewState;
}

function activePath(layout: PaneLayout): string {
  const selection = activeSelection(layout);
  return selection.kind === "blank" ? "/" : `/session/${selection.sessionId}`;
}

export interface PaneActions {
  syncRoute(selection: PaneSelection): void;
  newChat(): void;
  openSession(sessionId: SessionId): void;
  openSessionInPane(paneId: PaneId, sessionId: SessionId): void;
  split(direction: SplitDirection): void;
  close(paneId: PaneId): void;
  focus(paneId: PaneId): void;
  resize(ratio: number): void;
  drop(sessionId: SessionId, targetPaneId: PaneId, placement: DropPlacement): void;
  removeSession(sessionId: SessionId): void;
}

export function usePaneActions(): PaneActions {
  const controller = useController();
  const router = useRouter();

  const navigateToActive = useCallback(
    (layout: PaneLayout): void => {
      const path = activePath(layout);
      if (router.state.location.pathname === path) return;
      const selection = activeSelection(layout);
      if (selection.kind === "blank") {
        void router.navigate({ to: "/" });
      } else {
        void router.navigate({
          to: "/session/$sessionId",
          params: { sessionId: selection.sessionId },
        });
      }
    },
    [router],
  );

  return useMemo(
    () => ({
      syncRoute(selection) {
        controller.syncSelection(selection);
      },
      newChat() {
        navigateToActive(controller.selectBlank());
      },
      openSession(sessionId) {
        navigateToActive(controller.selectSession(sessionId));
      },
      openSessionInPane(paneId, sessionId) {
        navigateToActive(controller.selectSessionInPane(paneId, sessionId));
      },
      split(direction) {
        navigateToActive(controller.split(direction));
      },
      close(paneId) {
        navigateToActive(controller.close(paneId));
      },
      focus(paneId) {
        const current = controller.getSnapshot().layout;
        const layout = controller.focus(paneId);
        if (layout !== current) navigateToActive(layout);
      },
      resize(ratio) {
        controller.resize(ratio);
      },
      drop(sessionId, targetPaneId, placement) {
        navigateToActive(controller.drop(sessionId, targetPaneId, placement));
      },
      removeSession(sessionId) {
        navigateToActive(controller.removeSession(sessionId));
      },
    }),
    [controller, navigateToActive],
  );
}
