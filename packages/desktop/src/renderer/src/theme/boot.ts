/**
 * Applies the palette to the static HTML shell before first paint. Keeping it
 * in the boot entry avoids an inline script that the CSP would block.
 */
import { z } from "../schemas/zod.ts";

const THEME_STORAGE_KEY = "uji:theme";
const APPEARANCE_STORAGE_KEY = "uji:appearance:v1";

export type ThemePreference = "system" | "light" | "dark";
export type ToolCallDisplay = "auto" | "compact" | "detailed";
export type UiFont = "system" | "humanist" | "serif";
export type CodeFont = "system" | "menlo" | "mono";
export type FontSmoothing = "antialiased" | "auto";

export interface AppearanceSettings {
  readonly theme: ThemePreference;
  readonly uiFont: UiFont;
  readonly codeFont: CodeFont;
  readonly uiFontSize: number;
  readonly codeFontSize: number;
  readonly fontSmoothing: FontSmoothing;
  readonly toolCalls: ToolCallDisplay;
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "system",
  uiFont: "system",
  codeFont: "system",
  uiFontSize: 13,
  codeFontSize: 12,
  fontSmoothing: "antialiased",
  toolCalls: "auto",
};

const boundedInteger = (minimum: number, maximum: number) =>
  z
    .number()
    .finite()
    .transform((value) => Math.min(maximum, Math.max(minimum, Math.round(value))));

const storedAppearanceSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]).optional(),
    uiFont: z.enum(["system", "humanist", "serif"]).optional(),
    codeFont: z.enum(["system", "menlo", "mono"]).optional(),
    uiFontSize: boundedInteger(12, 16).optional(),
    codeFontSize: boundedInteger(11, 15).optional(),
    fontSmoothing: z.enum(["antialiased", "auto"]).optional(),
    toolCalls: z.enum(["auto", "compact", "detailed"]).optional(),
  })
  .strict();

const UI_FONTS: Readonly<Record<UiFont, string>> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  humanist: 'Inter, Avenir, "Segoe UI", sans-serif',
  serif: 'Charter, "Iowan Old Style", Georgia, serif',
};

const CODE_FONTS: Readonly<Record<CodeFont, string>> = {
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  menlo: 'Menlo, Monaco, "Courier New", monospace',
  mono: '"SF Mono", ui-monospace, Consolas, monospace',
};

const listeners = new Set<() => void>();

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function storedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function storedAppearance(): AppearanceSettings {
  const legacyTheme = storedTheme();
  try {
    const value = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (value === null) return { ...DEFAULT_APPEARANCE, theme: legacyTheme };
    const parsed = storedAppearanceSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return { ...DEFAULT_APPEARANCE, theme: legacyTheme };
    return {
      ...DEFAULT_APPEARANCE,
      ...parsed.data,
      theme: parsed.data.theme ?? legacyTheme,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE, theme: legacyTheme };
  }
}

let appearance = storedAppearance();

function apply(settings: AppearanceSettings): void {
  const preference = settings.theme;
  const dark = preference === "dark" || (preference === "system" && systemDark());
  const root = document.documentElement;
  root.dataset["theme"] = dark ? "dark" : "light";
  root.style.setProperty("--cursor-font-family-sans", UI_FONTS[settings.uiFont]);
  root.style.setProperty("--cursor-font-family-mono", CODE_FONTS[settings.codeFont]);
  root.style.setProperty("--cursor-font-size-xs", `${String(settings.uiFontSize - 2)}px`);
  root.style.setProperty("--cursor-font-size-sm", `${String(settings.uiFontSize - 1)}px`);
  root.style.setProperty("--cursor-font-size-base", `${String(settings.uiFontSize)}px`);
  root.style.setProperty("--cursor-font-size-lg", `${String(settings.uiFontSize + 1)}px`);
  root.style.setProperty("--cursor-font-size-code", `${String(settings.codeFontSize)}px`);
  root.style.setProperty("--cursor-line-height-xs", `${String(settings.uiFontSize + 1)}px`);
  root.style.setProperty("--cursor-line-height-sm", `${String(settings.uiFontSize + 3)}px`);
  root.style.setProperty("--cursor-line-height-base", `${String(settings.uiFontSize + 5)}px`);
  root.style.setProperty("--cursor-line-height-lg", `${String(settings.uiFontSize + 9)}px`);
  root.style.setProperty(
    "--uji-font-smoothing",
    settings.fontSmoothing === "antialiased" ? "antialiased" : "auto",
  );
  root.style.setProperty(
    "--uji-moz-font-smoothing",
    settings.fontSmoothing === "antialiased" ? "grayscale" : "auto",
  );
}

export function themePreference(): ThemePreference {
  return appearance.theme;
}

export function setThemePreference(preference: ThemePreference): void {
  setAppearanceSettings({ ...appearance, theme: preference });
}

export function appearanceSettings(): AppearanceSettings {
  return appearance;
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAppearanceSettings(next: AppearanceSettings): void {
  appearance = next;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Preference persistence is best-effort.
  }
  apply(next);
  for (const listener of listeners) listener();
}

export function currentThemeIsDark(): boolean {
  return document.documentElement.dataset["theme"] === "dark";
}

apply(appearance);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (appearance.theme === "system") apply(appearance);
});
