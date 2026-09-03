/**
 * One Settings dialog for desktop-wide preferences. These compact panels are
 * loaded with the sidebar: opening a local dialog should never introduce a
 * chunk boundary, fallback frame, or layout shift.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/settings-appearance.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { SessionId } from "@uji-ai/core";
import { Icon, type IconName } from "../components/icons.tsx";
import { focus, IconButton } from "../components/ui.tsx";
import {
  setStartupDestination,
  useStartupDestination,
  type StartupDestination,
} from "../startup-preference.ts";
import { settingsPatterns } from "../theme/settings-patterns.stylex.ts";
import { appearanceSettingsStyles as styles } from "./appearance-settings.stylex.ts";
import { AccountsSettings } from "./accounts-settings.tsx";
import { AppearanceSettings } from "./appearance-panel.tsx";
import { CustomizeSettings } from "./customize.tsx";
import { shellActions, useShellState, type SettingsSection } from "./shell-state.ts";

export type { SettingsSection };

export interface SettingsDialogProps {
  readonly onClose: () => void;
  readonly initialSection?: SettingsSection;
  readonly sessionId?: SessionId;
}

function Choice<T extends string>({
  value,
  selected,
  label,
  description,
  onSelect,
}: {
  value: T;
  selected: T;
  label: string;
  description: string;
  onSelect: (value: T) => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={value === selected}
      {...stylex.props(
        settingsPatterns.choice,
        focus.ring,
        value === selected && settingsPatterns.choiceSelected,
      )}
      onClick={() => onSelect(value)}
    >
      <span {...stylex.props(settingsPatterns.choiceLabel)}>{label}</span>
      <span {...stylex.props(settingsPatterns.choiceDescription)}>{description}</span>
    </button>
  );
}

function GeneralSettings(): ReactElement {
  const destination = useStartupDestination();

  return (
    <>
      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(settingsPatterns.sectionTitle)}>Startup</h2>
        <p {...stylex.props(settingsPatterns.sectionDescription)}>
          Choose what opens after Uji restores the current workspace.
        </p>
        <div {...stylex.props(settingsPatterns.choiceGrid, styles.segmentedTwo)}>
          {(
            [
              ["new-chat", "New chat", "Start with an empty, focused composer"],
              ["last-session", "Last session", "Return to the newest session"],
            ] satisfies readonly (readonly [StartupDestination, string, string])[]
          ).map(([value, label, description]) => (
            <Choice
              key={value}
              value={value}
              selected={destination}
              label={label}
              description={description}
              onSelect={setStartupDestination}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function settingsTitle(section: SettingsSection): string {
  switch (section) {
    case "general":
      return "General";
    case "appearance":
      return "Appearance";
    case "accounts":
      return "Accounts";
    case "customize":
      return "Customize";
    default: {
      const _exhaustive: never = section;
      return _exhaustive;
    }
  }
}

function SettingsPanel({
  section,
  sessionId,
}: {
  section: SettingsSection;
  sessionId: SessionId | undefined;
}): ReactElement {
  switch (section) {
    case "general":
      return <GeneralSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "accounts":
      return <AccountsSettings />;
    case "customize":
      return <CustomizeSettings sessionId={sessionId} />;
    default: {
      const _exhaustive: never = section;
      return _exhaustive;
    }
  }
}

const SECTIONS = [
  ["general", "settings"],
  ["appearance", "sparkle"],
  ["accounts", "user"],
  ["customize", "sparkle"],
] as const satisfies readonly (readonly [SettingsSection, IconName])[];

export function SettingsDialog({
  onClose,
  initialSection = "general",
  sessionId,
}: SettingsDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    initialFocusRef.current?.focus();
  }, []);

  const close = (): void => {
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="settings-dialog-title"
      {...stylex.props(styles.dialog)}
      onClose={onClose}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div {...stylex.props(styles.dialogInner)}>
        <nav aria-label="Settings sections" {...stylex.props(styles.navigation)}>
          <div {...stylex.props(styles.navTitle)}>Settings</div>
          <div {...stylex.props(styles.navList)}>
            {SECTIONS.map(([id, icon]) => (
              <button
                key={id}
                ref={section === id ? initialFocusRef : undefined}
                type="button"
                aria-current={section === id ? "page" : undefined}
                {...stylex.props(
                  styles.navItem,
                  focus.ringInset,
                  section === id && styles.navItemActive,
                )}
                onClick={() => setSection(id)}
              >
                <Icon name={icon} size={14} />
                {settingsTitle(id)}
              </button>
            ))}
          </div>
        </nav>
        <section {...stylex.props(styles.content)}>
          <header {...stylex.props(styles.header)}>
            <span id="settings-dialog-title" {...stylex.props(styles.title)}>
              {settingsTitle(section)}
            </span>
            <IconButton icon="x" label="Close settings" onClick={close} />
          </header>
          <div key={section} data-uji-scrollport="balanced" {...stylex.props(styles.scroll)}>
            <SettingsPanel section={section} sessionId={sessionId} />
          </div>
        </section>
      </div>
    </dialog>
  );
}

/** Mounted once in the shell; opens whichever section the shell store asks for. */
export function SettingsDialogHost(): ReactElement | null {
  const { settings } = useShellState();
  if (settings === undefined) return null;
  return (
    <SettingsDialog
      key={settings.section}
      initialSection={settings.section}
      sessionId={settings.sessionId}
      onClose={shellActions.closeSettings}
    />
  );
}
