/**
 * Eager workbench controller and rail. Panels mount on first visit, then
 * remain mounted while hidden so tab, close, pane, and route state survives.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/workbench.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";
import type { SessionId } from "@uji-ai/core";
import { workbench } from "../theme/schema.stylex";
import { t } from "../theme/vars.stylex";
import { BrowserPanel } from "./browser-panel";
import {
  clampWorkbenchWidth,
  WORKBENCH_WIDTH_DEFAULT,
  WORKBENCH_WIDTH_MAX,
  WORKBENCH_WIDTH_MIN,
  workbenchController,
  workbenchViewIdentity,
  workbenchViewKey,
  useWorkbenchSnapshot,
} from "./controller";
import type {
  WorkbenchLauncherTabId,
  WorkbenchTabId,
  WorkbenchTarget,
  WorkbenchViewKey,
  WorkbenchViewState,
} from "./controller";
import { WorkbenchLauncher } from "./launcher";

const ChangesPanel = lazy(() =>
  import("./changes-panel").then((module) => ({ default: module.ChangesPanel })),
);
const GitHubPanel = lazy(() =>
  import("./github-panel").then((module) => ({ default: module.GitHubPanel })),
);

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    minWidth: 0,
    minHeight: 0,
    flexShrink: 0,
    backgroundColor: t.bgBase,
  },
  panel: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: workbench.panelWidth,
    minHeight: 0,
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: t.borderSubtle,
    backgroundColor: t.bgBase,
    "@media (max-width: 920px)": {
      position: "absolute",
      zIndex: 20,
      top: 0,
      right: 0,
      bottom: 0,
      minWidth: workbench.panelWidth,
      maxWidth: "100vw",
      boxShadow: t.shadowModal,
    },
  },
  panelHidden: { display: "none" },
  panelSlot: {
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  panelSlotHidden: { display: "none" },
  loading: {
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "column",
    backgroundColor: t.bgBase,
  },
  loadingHeader: {
    height: workbench.headerHeight,
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: t.borderSubtle,
  },
  loadingBody: {
    display: "flex",
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    color: t.textTertiary,
    fontSize: t.fontSm,
  },
  sash: {
    position: "absolute",
    zIndex: 2,
    insetBlock: 0,
    insetInlineStart: -6,
    width: 12,
    borderStyle: "none",
    outlineStyle: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": t.fillGhostHover,
      ":focus-visible": t.fillGhostSelected,
    },
    cursor: "col-resize",
    touchAction: "none",
    WebkitAppRegion: "no-drag",
  },
  sashActive: { backgroundColor: t.fillPrimary, opacity: 0.25 },
});

interface ResizeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  nextWidth: number;
}

function PanelLoading({ label }: { readonly label: string }): ReactElement {
  return (
    <section role="status" aria-label={label} {...stylex.props(styles.loading)}>
      <div {...stylex.props(styles.loadingHeader)} />
      <div {...stylex.props(styles.loadingBody)}>{label}</div>
    </section>
  );
}

interface PanelContentProps {
  readonly tab: WorkbenchTabId;
  readonly sessionId: SessionId | undefined;
  readonly view: WorkbenchViewState;
  readonly onClose: () => void;
  readonly onHome: () => void;
  readonly onOpen: (tab: WorkbenchLauncherTabId) => void;
  readonly onSelectPath: (path: string | undefined) => void;
  readonly onChangesScroll: (scrollTop: number) => void;
  readonly onGitHubScroll: (scrollTop: number) => void;
  readonly onToggleWidth: () => void;
}

function PanelContent({
  tab,
  sessionId,
  view,
  onClose,
  onHome,
  onOpen,
  onSelectPath,
  onChangesScroll,
  onGitHubScroll,
  onToggleWidth,
}: PanelContentProps): ReactElement {
  switch (tab) {
    case "launcher":
      return (
        <WorkbenchLauncher
          atMaximumWidth={view.width === WORKBENCH_WIDTH_MAX}
          onClose={onClose}
          onOpen={onOpen}
          onToggleWidth={onToggleWidth}
        />
      );
    case "changes":
      return (
        <Suspense fallback={<PanelLoading label="Loading changes" />}>
          <ChangesPanel
            sessionId={sessionId}
            selectedPath={view.selectedPath}
            scrollTop={view.scrollTop.changes}
            onSelectPath={onSelectPath}
            onScrollTop={onChangesScroll}
            onHome={onHome}
            onClose={onClose}
          />
        </Suspense>
      );
    case "browser":
      return <BrowserPanel onClose={onClose} onHome={onHome} />;
    case "pull-request":
      return (
        <Suspense fallback={<PanelLoading label="Loading pull request" />}>
          <GitHubPanel
            scrollTop={view.scrollTop["pull-request"]}
            onScrollTop={onGitHubScroll}
            onHome={onHome}
            onClose={onClose}
          />
        </Suspense>
      );
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

function WorkbenchViewHost({
  viewKey,
  target,
  view,
  current,
}: {
  readonly viewKey: WorkbenchViewKey;
  readonly target: WorkbenchTarget;
  readonly view: WorkbenchViewState;
  readonly current: boolean;
}): ReactElement {
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const resizeRef = useRef<ResizeState | undefined>(undefined);
  const close = useCallback(() => workbenchController.actions.close(viewKey), [viewKey]);
  const home = useCallback(
    () => workbenchController.actions.openTab(viewKey, "launcher"),
    [viewKey],
  );
  const open = useCallback(
    (tab: WorkbenchLauncherTabId) => workbenchController.actions.openTab(viewKey, tab),
    [viewKey],
  );
  const selectPath = useCallback(
    (path: string | undefined) => workbenchController.actions.selectPath(viewKey, path),
    [viewKey],
  );
  const setChangesScroll = useCallback(
    (scrollTop: number) => workbenchController.actions.setScrollTop(viewKey, "changes", scrollTop),
    [viewKey],
  );
  const setGitHubScroll = useCallback(
    (scrollTop: number) =>
      workbenchController.actions.setScrollTop(viewKey, "pull-request", scrollTop),
    [viewKey],
  );
  const toggleWidth = useCallback(
    () =>
      workbenchController.actions.setWidth(
        viewKey,
        view.width === WORKBENCH_WIDTH_MAX ? WORKBENCH_WIDTH_DEFAULT : WORKBENCH_WIDTH_MAX,
      ),
    [view.width, viewKey],
  );

  const beginResize = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: view.width,
      nextWidth: view.width,
    };
    setResizing(true);
  };

  const moveResize = (event: PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    resize.nextWidth = clampWorkbenchWidth(resize.startWidth + resize.startX - event.clientX);
    if (panelRef.current !== null) panelRef.current.style.width = `${String(resize.nextWidth)}px`;
  };

  const endResize = (event: PointerEvent<HTMLDivElement>): void => {
    const resize = resizeRef.current;
    if (resize === undefined || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = undefined;
    workbenchController.actions.setWidth(viewKey, resize.nextWidth);
    setResizing(false);
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    let width: number | undefined;
    if (event.key === "ArrowLeft") width = view.width + 20;
    else if (event.key === "ArrowRight") width = view.width - 20;
    else if (event.key === "Home") width = WORKBENCH_WIDTH_MIN;
    else if (event.key === "End") width = WORKBENCH_WIDTH_MAX;
    if (width === undefined) return;
    event.preventDefault();
    workbenchController.actions.setWidth(viewKey, width);
  };

  const visible = current && view.expanded;
  return (
    <section
      ref={panelRef}
      hidden={!visible}
      aria-hidden={!visible}
      inert={!visible ? true : undefined}
      {...stylex.props(styles.panel, !visible && styles.panelHidden)}
      style={{ width: view.width }}
    >
      <div
        role="separator"
        tabIndex={visible ? 0 : -1}
        aria-label="Resize workbench"
        aria-orientation="vertical"
        aria-valuemin={WORKBENCH_WIDTH_MIN}
        aria-valuemax={WORKBENCH_WIDTH_MAX}
        aria-valuenow={view.width}
        {...stylex.props(styles.sash, resizing && styles.sashActive)}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      {view.visitedTabs.map((tab) => {
        const panelVisible = visible && view.activeTab === tab;
        return (
          <div
            key={tab}
            hidden={!panelVisible}
            aria-hidden={!panelVisible}
            inert={!panelVisible ? true : undefined}
            {...stylex.props(styles.panelSlot, !panelVisible && styles.panelSlotHidden)}
          >
            <PanelContent
              tab={tab}
              sessionId={target.kind === "session" ? target.sessionId : undefined}
              view={view}
              onClose={close}
              onHome={home}
              onOpen={open}
              onSelectPath={selectPath}
              onChangesScroll={setChangesScroll}
              onGitHubScroll={setGitHubScroll}
              onToggleWidth={toggleWidth}
            />
          </div>
        );
      })}
    </section>
  );
}

export interface WorkbenchProps {
  readonly target: WorkbenchTarget;
  /** Stable stage identity; views are keyed on it together with their data target. */
  readonly paneKey: string;
}

export function Workbench({ target, paneKey }: WorkbenchProps): ReactElement {
  const viewKey = workbenchViewKey({ paneKey, target });
  const snapshot = useWorkbenchSnapshot();
  const paneViews = [...snapshot.views].flatMap(([knownViewKey, view]) => {
    const identity = workbenchViewIdentity(knownViewKey);
    return identity?.paneKey === paneKey ? [{ identity, view }] : [];
  });

  return (
    <aside {...stylex.props(styles.root)} aria-label="Workbench">
      {paneViews.map(({ identity, view }) => (
        <WorkbenchViewHost
          key={identity.key}
          viewKey={identity.key}
          target={identity.target}
          view={view}
          current={identity.key === viewKey}
        />
      ))}
    </aside>
  );
}
