/**
 * Permanent window chrome. The sidebar toggle stays on the rail side; chat
 * actions and the stage-level workbench entry stay at the trailing edge.
 */
import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";
import type { ReactElement } from "react";
import { Menu, MenuItem } from "../components/menu.tsx";
import { IconButton } from "../components/ui.tsx";
import { usePaneActions, usePaneControllerSnapshot } from "../layout/pane-context.tsx";
import { activePane } from "../layout/pane-layout.ts";
import { useHostState } from "../queries.ts";
import { shell, sidebar } from "../theme/schema.stylex.ts";
import { t } from "../theme/vars.stylex.ts";
import {
  WORKBENCH_STAGE_PANE_KEY,
  workbenchController,
  workbenchViewKey,
  useWorkbenchSnapshot,
} from "../workbench/controller.ts";
import type { WorkbenchTarget } from "../workbench/controller.ts";
import { shellActions, useShellState } from "./shell-state.ts";

const styles = stylex.create({
  bar: {
    position: "relative",
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    height: shell.titlebarHeight,
    paddingInlineEnd: 10,
    paddingInlineStart: 10,
    flexShrink: 0,
    backgroundColor: t.bgBase,
    WebkitAppRegion: "drag",
  },
  sidebarFill: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: sidebar.width,
    backgroundColor: t.bgSubtle,
    pointerEvents: "none",
    transitionProperty: "width",
    transitionDuration: t.durationSlow,
    transitionTimingFunction: t.easeOutQuint,
    "@media (prefers-reduced-motion: reduce)": { transitionDuration: "0s" },
  },
  sidebarFillHidden: { width: 0 },
  // Traffic-light inset on macOS; the toggle then sits where the rail begins.
  barMac: { paddingInlineStart: 84 },
  actionTrack: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    flexShrink: 0,
    position: "relative",
    zIndex: 1,
    WebkitAppRegion: "no-drag",
  },
  spacer: { flex: 1, minWidth: 0 },
});

export function Titlebar(): ReactElement {
  const host = useHostState();
  const { layout } = usePaneControllerSnapshot();
  const panes = usePaneActions();
  const workbench = useWorkbenchSnapshot();
  const { sidebarVisible } = useShellState();
  const mac = host.data?.platform === "darwin";
  const selection = activePane(layout).selection;
  const workspacePath = host.data?.workspace?.path;
  const modifier = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";
  const target: WorkbenchTarget | undefined =
    selection.kind === "session"
      ? { kind: "session", sessionId: selection.sessionId }
      : workspacePath === undefined
        ? undefined
        : { kind: "workspace", workspacePath };
  const viewKey =
    target === undefined
      ? undefined
      : workbenchViewKey({ paneKey: WORKBENCH_STAGE_PANE_KEY, target });
  const view = viewKey === undefined ? undefined : workbench.views.get(viewKey);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const platformModifier = mac ? event.metaKey : event.ctrlKey;
      if (
        viewKey === undefined ||
        event.key.toLowerCase() !== "b" ||
        !event.altKey ||
        !platformModifier
      ) {
        return;
      }
      event.preventDefault();
      if (view?.expanded === true) {
        workbenchController.actions.close(viewKey);
        return;
      }
      workbenchController.actions.openTab(
        viewKey,
        view?.activeTab ?? workbenchController.getView(viewKey).activeTab,
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mac, view?.activeTab, view?.expanded, viewKey]);

  return (
    <header {...stylex.props(styles.bar, mac && styles.barMac)}>
      <span
        aria-hidden="true"
        {...stylex.props(styles.sidebarFill, !sidebarVisible && styles.sidebarFillHidden)}
      />
      <span {...stylex.props(styles.actionTrack)}>
        <IconButton
          icon="panel-left"
          label={sidebarVisible ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarVisible}
          aria-keyshortcuts={mac ? "Meta+B" : "Control+B"}
          onClick={() => shellActions.toggleSidebar()}
        />
      </span>
      <span {...stylex.props(styles.spacer)} />
      {selection.kind === "blank" && layout.kind === "single" && (
        <span {...stylex.props(styles.actionTrack)}>
          <Menu
            label="Chat actions"
            align="end"
            trigger={<IconButton icon="more" label="Chat actions" />}
          >
            <MenuItem
              icon="split-down"
              meta={`${shift}${modifier}D`}
              onSelect={() => panes.split("down")}
            >
              Split Down
            </MenuItem>
            <MenuItem
              icon="split-right"
              meta={`${modifier}D`}
              onSelect={() => panes.split("right")}
            >
              Split Right
            </MenuItem>
          </Menu>
        </span>
      )}
      {viewKey !== undefined && view?.expanded !== true && (
        <span {...stylex.props(styles.actionTrack)}>
          <IconButton
            icon="panel-right"
            label="Show workbench"
            aria-keyshortcuts={mac ? "Meta+Alt+B" : "Control+Alt+B"}
            onClick={() =>
              workbenchController.actions.openTab(
                viewKey,
                view?.activeTab ?? workbenchController.getView(viewKey).activeTab,
              )
            }
          />
        </span>
      )}
    </header>
  );
}
