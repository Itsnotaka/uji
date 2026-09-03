/**
 * Window-lifetime workbench state. The controller lives outside route leaves,
 * so a pane can change sessions without throwing away loaded panel state.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/workbench-controller.ts
 */
import { useSyncExternalStore } from "react";
import type { SessionId } from "@uji-ai/core";
import { z } from "../schemas/zod.ts";

export const WORKBENCH_WIDTH_DEFAULT = 384;
export const WORKBENCH_WIDTH_MIN = 384;
export const WORKBENCH_WIDTH_MAX = 960;
export const WORKBENCH_STAGE_PANE_KEY = "stage";

export type WorkbenchTabId = "launcher" | "changes" | "browser" | "pull-request";
export type WorkbenchLauncherTabId = "changes" | "browser";
export type WorkbenchScrollableTabId = "changes" | "pull-request";
export type WorkbenchViewKey = string & { readonly __brand: "WorkbenchViewKey" };

export type WorkbenchTarget =
  | { readonly kind: "workspace"; readonly workspacePath: string }
  | { readonly kind: "session"; readonly sessionId: SessionId };

export interface WorkbenchViewIdentity {
  readonly key: WorkbenchViewKey;
  readonly paneKey: string;
  readonly target: WorkbenchTarget;
}

export interface WorkbenchTabDefinition {
  readonly id: WorkbenchTabId;
  readonly label: string;
  readonly panelLabel: string;
}

export const WORKBENCH_TABS = [
  { id: "launcher", label: "Workbench", panelLabel: "Workbench launcher" },
  { id: "changes", label: "Changes", panelLabel: "Workspace changes" },
  { id: "browser", label: "Browser", panelLabel: "Browser" },
  { id: "pull-request", label: "Pull request", panelLabel: "GitHub pull request" },
] satisfies readonly WorkbenchTabDefinition[];

export const WORKBENCH_LAUNCHER_TABS = [
  "changes",
  "browser",
] satisfies readonly WorkbenchLauncherTabId[];

export interface WorkbenchScrollState {
  readonly changes: number;
  readonly "pull-request": number;
}

export interface WorkbenchViewState {
  readonly expanded: boolean;
  readonly activeTab: WorkbenchTabId;
  readonly visitedTabs: readonly WorkbenchTabId[];
  readonly selectedPath: string | undefined;
  readonly width: number;
  readonly scrollTop: WorkbenchScrollState;
}

export interface WorkbenchSnapshot {
  readonly views: ReadonlyMap<WorkbenchViewKey, WorkbenchViewState>;
}

export interface WorkbenchPersistence {
  read(): PersistedWorkbenchSnapshot | undefined;
  write(value: PersistedWorkbenchSnapshot): void;
}

export interface WorkbenchController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WorkbenchSnapshot;
  readonly getView: (key: WorkbenchViewKey) => WorkbenchViewState;
  readonly actions: {
    readonly toggleTab: (key: WorkbenchViewKey, tab: WorkbenchTabId) => void;
    readonly openTab: (key: WorkbenchViewKey, tab: WorkbenchTabId) => void;
    readonly close: (key: WorkbenchViewKey) => void;
    readonly selectPath: (key: WorkbenchViewKey, path: string | undefined) => void;
    readonly setWidth: (key: WorkbenchViewKey, width: number) => void;
    readonly setScrollTop: (
      key: WorkbenchViewKey,
      tab: WorkbenchScrollableTabId,
      scrollTop: number,
    ) => void;
  };
}

const STORAGE_KEY = "uji:desktop:workbench:v1";
const VIEW_IDENTITIES = new Map<WorkbenchViewKey, WorkbenchViewIdentity>();
const EMPTY_SCROLL = Object.freeze({ changes: 0, "pull-request": 0 });
const DEFAULT_VIEW = Object.freeze({
  expanded: false,
  activeTab: "launcher",
  visitedTabs: Object.freeze([]),
  selectedPath: undefined,
  width: WORKBENCH_WIDTH_DEFAULT,
  scrollTop: EMPTY_SCROLL,
}) satisfies WorkbenchViewState;

const persistedWorkbenchView = z.strictObject({
  key: z.string().min(1),
  expanded: z.boolean(),
  activeTab: z.enum(["launcher", "changes", "browser", "pull-request"]),
  selectedPath: z.string().min(1).optional(),
  width: z.number().finite(),
  scrollTop: z.strictObject({
    changes: z.number().finite().nonnegative(),
    "pull-request": z.number().finite().nonnegative(),
  }),
});

const persistedWorkbenchSnapshot = z.strictObject({
  version: z.literal(1),
  views: z.array(persistedWorkbenchView),
});

export type PersistedWorkbenchSnapshot = z.output<typeof persistedWorkbenchSnapshot>;

export function clampWorkbenchWidth(width: number): number {
  return Math.min(WORKBENCH_WIDTH_MAX, Math.max(WORKBENCH_WIDTH_MIN, Math.round(width)));
}

/** Decode localStorage once; the controller never receives transport data. */
export function decodePersistedWorkbenchSnapshot(
  serialized: string,
): PersistedWorkbenchSnapshot | undefined {
  try {
    const result = persistedWorkbenchSnapshot.safeParse(JSON.parse(serialized));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function restoreSnapshot(persisted: PersistedWorkbenchSnapshot | undefined): WorkbenchSnapshot {
  const views = new Map<WorkbenchViewKey, WorkbenchViewState>();
  for (const stored of persisted?.views ?? []) {
    // SAFETY: the persistence schema proved that this storage key is non-empty.
    const key = stored.key as WorkbenchViewKey;
    views.set(
      key,
      Object.freeze({
        expanded: stored.expanded,
        activeTab: stored.activeTab,
        visitedTabs: Object.freeze(stored.expanded ? [stored.activeTab] : []),
        selectedPath: stored.selectedPath,
        width: clampWorkbenchWidth(stored.width),
        scrollTop: Object.freeze(stored.scrollTop),
      }),
    );
  }
  return Object.freeze({ views });
}

function persistable(snapshot: WorkbenchSnapshot): PersistedWorkbenchSnapshot {
  return {
    version: 1,
    views: [...snapshot.views].map(([key, view]) => ({
      key,
      expanded: view.expanded,
      activeTab: view.activeTab,
      selectedPath: view.selectedPath,
      width: view.width,
      scrollTop: view.scrollTop,
    })),
  };
}

function browserPersistence(): WorkbenchPersistence | undefined {
  if (globalThis.window === undefined) return undefined;
  return {
    read() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw === null ? undefined : decodePersistedWorkbenchSnapshot(raw);
      } catch {
        return undefined;
      }
    },
    write(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // A blocked or full localStorage must not erase the in-memory view.
      }
    },
  };
}

export function workbenchViewKey(input: {
  readonly paneKey: string;
  readonly target: WorkbenchTarget;
}): WorkbenchViewKey {
  if (input.paneKey === "") throw new Error("Invalid workbench pane key: empty");
  const targetKey =
    input.target.kind === "session"
      ? encodeURIComponent(input.target.sessionId)
      : `workspace:${encodeURIComponent(input.target.workspacePath)}`;
  // SAFETY: the non-empty pane key and discriminated target are encoded into a stable key.
  const key = `${encodeURIComponent(input.paneKey)}:${targetKey}` as WorkbenchViewKey;
  if (!VIEW_IDENTITIES.has(key)) {
    VIEW_IDENTITIES.set(
      key,
      Object.freeze({ key, paneKey: input.paneKey, target: Object.freeze({ ...input.target }) }),
    );
  }
  return key;
}

export function workbenchViewIdentity(key: WorkbenchViewKey): WorkbenchViewIdentity | undefined {
  return VIEW_IDENTITIES.get(key);
}

function freezeView(view: WorkbenchViewState): WorkbenchViewState {
  return Object.freeze({
    ...view,
    visitedTabs: Object.freeze([...view.visitedTabs]),
    scrollTop: Object.freeze({ ...view.scrollTop }),
  });
}

export function createWorkbenchController(persistence?: WorkbenchPersistence): WorkbenchController {
  let snapshot = restoreSnapshot(persistence?.read());
  const listeners = new Set<() => void>();

  const publish = (key: WorkbenchViewKey, view: WorkbenchViewState): void => {
    const views = new Map(snapshot.views);
    views.set(key, freezeView(view));
    snapshot = Object.freeze({
      views,
    });
    persistence?.write(persistable(snapshot));
    for (const listener of listeners) listener();
  };

  const update = (
    key: WorkbenchViewKey,
    change: (current: WorkbenchViewState) => WorkbenchViewState,
  ): void => {
    const current = snapshot.views.get(key) ?? DEFAULT_VIEW;
    const next = change(current);
    if (next !== current) publish(key, next);
  };

  const visit = (current: WorkbenchViewState, tab: WorkbenchTabId): readonly WorkbenchTabId[] =>
    current.visitedTabs.includes(tab) ? current.visitedTabs : [...current.visitedTabs, tab];

  const actions: WorkbenchController["actions"] = {
    toggleTab(key, tab) {
      update(key, (current) =>
        current.expanded && current.activeTab === tab
          ? { ...current, expanded: false }
          : { ...current, expanded: true, activeTab: tab, visitedTabs: visit(current, tab) },
      );
    },
    openTab(key, tab) {
      update(key, (current) =>
        current.expanded && current.activeTab === tab && current.visitedTabs.includes(tab)
          ? current
          : { ...current, expanded: true, activeTab: tab, visitedTabs: visit(current, tab) },
      );
    },
    close(key) {
      update(key, (current) => (current.expanded ? { ...current, expanded: false } : current));
    },
    selectPath(key, path) {
      update(key, (current) =>
        current.selectedPath === path ? current : { ...current, selectedPath: path },
      );
    },
    setWidth(key, width) {
      const nextWidth = clampWorkbenchWidth(width);
      update(key, (current) =>
        current.width === nextWidth ? current : { ...current, width: nextWidth },
      );
    },
    setScrollTop(key, tab, scrollTop) {
      const nextScroll = Math.max(0, scrollTop);
      update(key, (current) =>
        current.scrollTop[tab] === nextScroll
          ? current
          : { ...current, scrollTop: { ...current.scrollTop, [tab]: nextScroll } },
      );
    },
  };

  return Object.freeze({
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getView: (key: WorkbenchViewKey) => snapshot.views.get(key) ?? DEFAULT_VIEW,
    actions: Object.freeze(actions),
  });
}

export const workbenchController = createWorkbenchController(browserPersistence());

export function useWorkbenchSnapshot(): WorkbenchSnapshot {
  return useSyncExternalStore(
    workbenchController.subscribe,
    workbenchController.getSnapshot,
    workbenchController.getSnapshot,
  );
}

export function useWorkbenchView(key: WorkbenchViewKey): WorkbenchViewState {
  const snapshot = useWorkbenchSnapshot();
  return snapshot.views.get(key) ?? DEFAULT_VIEW;
}
