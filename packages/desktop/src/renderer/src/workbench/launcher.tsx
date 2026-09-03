import * as stylex from "@stylexjs/stylex";
import { IconExpand } from "central-icons";
import { useRef } from "react";
import type { ReactElement } from "react";
import { Icon } from "../components/icons";
import { focus, IconButton } from "../components/ui";
import { t } from "../theme/vars.stylex";
import { WORKBENCH_LAUNCHER_TABS } from "./controller";
import type { WorkbenchLauncherTabId } from "./controller";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "flex",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    paddingBottom: 78,
    backgroundColor: t.bgBase,
  },
  toolbar: {
    position: "absolute",
    insetBlockStart: 8,
    insetInline: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    pointerEvents: "none",
  },
  toolbarGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    pointerEvents: "auto",
  },
  toolbarButton: {
    display: "inline-flex",
    width: 28,
    height: 28,
    padding: 0,
    alignItems: "center",
    justifyContent: "center",
    borderStyle: "none",
    borderRadius: t.radiusLg,
    backgroundColor: { default: "transparent", ":hover": t.fillGhostHover },
    color: t.iconSecondary,
    cursor: "pointer",
  },
  choices: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
    width: "min(456px, 100%)",
  },
  choice: {
    display: "flex",
    aspectRatio: "1 / 1",
    flexDirection: "column",
    minWidth: 0,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: t.borderWeak, ":hover": t.borderDefault },
    borderRadius: t.radiusLg,
    backgroundColor: { default: "transparent", ":hover": t.fillGhostHover },
    color: t.textSecondary,
    fontSize: t.fontLg,
    fontWeight: 500,
    textAlign: "center",
    cursor: "pointer",
  },
  choiceIcon: {
    display: "inline-flex",
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: t.iconSecondary,
    lineHeight: 0,
  },
  choiceLabel: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

function ChoiceIcon({ tab }: { readonly tab: WorkbenchLauncherTabId }): ReactElement {
  switch (tab) {
    case "changes":
      return <Icon name="git-branch" size={28} />;
    case "browser":
      return <Icon name="globe" size={28} />;
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

function tabLabel(tab: WorkbenchLauncherTabId): string {
  switch (tab) {
    case "changes":
      return "Changes";
    case "browser":
      return "Browser";
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

export interface WorkbenchLauncherProps {
  readonly atMaximumWidth: boolean;
  readonly onClose: () => void;
  readonly onOpen: (tab: WorkbenchLauncherTabId) => void;
  readonly onToggleWidth: () => void;
}

export function WorkbenchLauncher({
  atMaximumWidth,
  onClose,
  onOpen,
  onToggleWidth,
}: WorkbenchLauncherProps): ReactElement {
  const firstChoiceRef = useRef<HTMLButtonElement>(null);

  return (
    <section aria-label="Workbench launcher" {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.toolbar)}>
        <div {...stylex.props(styles.toolbarGroup)}>
          <IconButton
            icon="plus"
            label="Focus workbench choices"
            onClick={() => firstChoiceRef.current?.focus()}
          />
        </div>
        <div {...stylex.props(styles.toolbarGroup)}>
          <button
            type="button"
            aria-pressed={atMaximumWidth}
            aria-label={atMaximumWidth ? "Restore workbench width" : "Expand workbench"}
            title={atMaximumWidth ? "Restore workbench width" : "Expand workbench"}
            {...stylex.props(styles.toolbarButton, focus.ring)}
            onClick={onToggleWidth}
          >
            <IconExpand size={16} mode="raw" ariaHidden />
          </button>
          <IconButton icon="panel-right" label="Close workbench" size={13} onClick={onClose} />
        </div>
      </div>

      <div {...stylex.props(styles.choices)}>
        {WORKBENCH_LAUNCHER_TABS.map((tab, index) => (
          <button
            key={tab}
            ref={index === 0 ? firstChoiceRef : undefined}
            type="button"
            {...stylex.props(styles.choice, focus.ring)}
            onClick={() => onOpen(tab)}
          >
            <span {...stylex.props(styles.choiceIcon)}>
              <ChoiceIcon tab={tab} />
            </span>
            <span {...stylex.props(styles.choiceLabel)}>{tabLabel(tab)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
