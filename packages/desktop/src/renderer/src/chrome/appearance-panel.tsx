/**
 * Appearance controls adapted to Uji's small desktop-wide settings model.
 * Components still consume semantic tokens; this panel only changes their
 * root values.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/settings-appearance.tsx
 */
import * as stylex from "@stylexjs/stylex";
import type { ReactElement, ReactNode } from "react";
import { focus } from "../components/ui.tsx";
import {
  setAppearanceSettings,
  type AppearanceSettings,
  type CodeFont,
  type ThemePreference,
  type ToolCallDisplay,
  type UiFont,
} from "../theme/boot.ts";
import { settingsPatterns } from "../theme/settings-patterns.stylex.ts";
import { useAppearanceSettings } from "../theme/use-appearance.ts";
import { appearancePanelStyles as styles } from "./appearance-panel.stylex.ts";

function update(settings: AppearanceSettings, patch: Partial<AppearanceSettings>): void {
  setAppearanceSettings({ ...settings, ...patch });
}

function readUiFont(value: string): UiFont | undefined {
  return value === "system" || value === "humanist" || value === "serif" ? value : undefined;
}

function readCodeFont(value: string): CodeFont | undefined {
  return value === "system" || value === "menlo" || value === "mono" ? value : undefined;
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

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>{label}</span>
      {children}
    </label>
  );
}

export function AppearanceSettings(): ReactElement {
  const settings = useAppearanceSettings();

  return (
    <div {...stylex.props(styles.root)}>
      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(settingsPatterns.sectionTitle)}>Color mode</h2>
        <p {...stylex.props(settingsPatterns.sectionDescription)}>
          Follow the operating system or keep one palette.
        </p>
        <div {...stylex.props(settingsPatterns.choiceGrid)}>
          {(
            [
              ["system", "System", "Match your device"],
              ["light", "Light", "Bright workspace"],
              ["dark", "Dark", "Low-light workspace"],
            ] satisfies readonly (readonly [ThemePreference, string, string])[]
          ).map(([value, label, description]) => (
            <Choice
              key={value}
              value={value}
              selected={settings.theme}
              label={label}
              description={description}
              onSelect={(theme) => update(settings, { theme })}
            />
          ))}
        </div>
      </section>

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(settingsPatterns.sectionTitle)}>Text</h2>
        <p {...stylex.props(settingsPatterns.sectionDescription)}>
          These choices apply to the interface, code, and diffs.
        </p>
        <div {...stylex.props(styles.fields)}>
          <Field label="Interface font">
            <select
              {...stylex.props(styles.select, focus.ring)}
              value={settings.uiFont}
              onChange={(event) => {
                const uiFont = readUiFont(event.target.value);
                if (uiFont !== undefined) update(settings, { uiFont });
              }}
            >
              <option value="system">System</option>
              <option value="humanist">Humanist sans</option>
              <option value="serif">Serif</option>
            </select>
          </Field>
          <Field label="Interface size">
            <span {...stylex.props(styles.rangeWrap)}>
              <input
                {...stylex.props(styles.range)}
                type="range"
                min={12}
                max={16}
                value={settings.uiFontSize}
                onChange={(event) => update(settings, { uiFontSize: event.target.valueAsNumber })}
              />
              <output {...stylex.props(styles.rangeValue)}>{settings.uiFontSize}</output>
            </span>
          </Field>
          <Field label="Code font">
            <select
              {...stylex.props(styles.select, focus.ring)}
              value={settings.codeFont}
              onChange={(event) => {
                const codeFont = readCodeFont(event.target.value);
                if (codeFont !== undefined) update(settings, { codeFont });
              }}
            >
              <option value="system">System mono</option>
              <option value="menlo">Menlo</option>
              <option value="mono">SF Mono</option>
            </select>
          </Field>
          <Field label="Code size">
            <span {...stylex.props(styles.rangeWrap)}>
              <input
                {...stylex.props(styles.range)}
                type="range"
                min={11}
                max={15}
                value={settings.codeFontSize}
                onChange={(event) => update(settings, { codeFontSize: event.target.valueAsNumber })}
              />
              <output {...stylex.props(styles.rangeValue)}>{settings.codeFontSize}</output>
            </span>
          </Field>
          <Field label="Font smoothing">
            <button
              type="button"
              role="switch"
              aria-checked={settings.fontSmoothing === "antialiased"}
              {...stylex.props(
                styles.switchButton,
                focus.ring,
                settings.fontSmoothing === "antialiased" && styles.switchOn,
              )}
              onClick={() =>
                update(settings, {
                  fontSmoothing: settings.fontSmoothing === "antialiased" ? "auto" : "antialiased",
                })
              }
            >
              <span
                {...stylex.props(
                  styles.switchKnob,
                  settings.fontSmoothing === "antialiased" && styles.switchKnobOn,
                )}
              />
            </button>
          </Field>
        </div>
      </section>

      <section {...stylex.props(styles.section)}>
        <h2 {...stylex.props(settingsPatterns.sectionTitle)}>Work detail</h2>
        <p {...stylex.props(settingsPatterns.sectionDescription)}>
          Decide how much tool activity stays expanded in a conversation.
        </p>
        <div {...stylex.props(settingsPatterns.choiceGrid)}>
          {(
            [
              ["auto", "Auto", "Group routine actions"],
              ["compact", "Compact", "Group every action"],
              ["detailed", "Detailed", "Expand every action"],
            ] satisfies readonly (readonly [ToolCallDisplay, string, string])[]
          ).map(([value, label, description]) => (
            <Choice
              key={value}
              value={value}
              selected={settings.toolCalls}
              label={label}
              description={description}
              onSelect={(toolCalls) => update(settings, { toolCalls })}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
