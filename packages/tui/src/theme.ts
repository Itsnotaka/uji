import process from "node:process";

export type ThemeMode = "dark" | "light";

/**
 * Semantic colors for every OpenTUI surface. Components consume roles from
 * this object; they do not own palettes or choose colors independently.
 */
export type CliTheme = Readonly<{
  mode: ThemeMode;
  transparent: "transparent";
  terminal: string;
  background: string;
  hover: string;
  codeBackground: string;
  foreground: string;
  dim: string;
  muted: string;
  accent: string;
  user: string;
  thinking: string;
  tool: string;
  error: string;
  warning: string;
  ok: string;
  command: string;
  running: string;
  link: string;
  path: string;
  code: string;
  number: string;
  string: string;
  type: string;
  operator: string;
  promptBorder: string;
  promptBorderFocused: string;
  selectionBackground: string;
  selectionForeground: string;
  userBackground: string;
  pasteBackground: string;
  pasteForeground: string;
  scrollbarTrack: string;
  scrollbarThumb: string;
  diffAddedBackground: string;
  diffRemovedBackground: string;
}>;

/** A stable object lets long-lived renderers see a palette change in place. */
type ActiveCliTheme = { -readonly [Role in keyof CliTheme]: CliTheme[Role] };

/** Copy a frozen palette into the stable object shared by every TUI component. */
export function createActiveTheme(theme: CliTheme): ActiveCliTheme {
  return { ...theme };
}

/** Change that stable object without replacing the references components hold. */
export function updateActiveTheme(target: ActiveCliTheme, theme: CliTheme): void {
  Object.assign(target, theme);
}

/**
 * Neutral gray base with cool accents for dark terminals.
 *
 * Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-render/src/theme/groknight.rs
 */
export const DARK_THEME: CliTheme = Object.freeze({
  mode: "dark",
  transparent: "transparent",
  terminal: "#0a0a0a",
  background: "#141414",
  hover: "#2c2c2c",
  codeBackground: "#1c1c1c",
  foreground: "#e1e1e1",
  dim: "#6c6c6c",
  muted: "#585858",
  accent: "#7aa2f7",
  user: "#c8c8c8",
  thinking: "#bb9af7",
  tool: "#787878",
  error: "#f7768e",
  warning: "#e0af68",
  ok: "#9ece6a",
  command: "#e0af68",
  running: "#7dcfff",
  link: "#7aa6da",
  path: "#ff9e64",
  code: "#3a95ab",
  number: "#ff9e64",
  string: "#9ece6a",
  type: "#7dcfff",
  operator: "#f7768e",
  promptBorder: "#323237",
  promptBorderFocused: "#505058",
  selectionBackground: "#363636",
  selectionForeground: "#e1e1e1",
  userBackground: "#242424",
  pasteBackground: "#111111",
  pasteForeground: "#c8c8c8",
  scrollbarTrack: "#111111",
  scrollbarThumb: "#242424",
  diffAddedBackground: "#063806",
  diffRemovedBackground: "#420e14",
});

/**
 * Neutral gray base with deeper accents for light terminals.
 *
 * Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-render/src/theme/grokday.rs
 */
export const LIGHT_THEME: CliTheme = Object.freeze({
  mode: "light",
  transparent: "transparent",
  terminal: "#f5f5f5",
  background: "#eeeeee",
  hover: "#d0d0d0",
  codeBackground: "#e4e4e4",
  foreground: "#262626",
  dim: "#767676",
  muted: "#a5a5a5",
  accent: "#2f64d2",
  user: "#444444",
  thinking: "#7d4bc6",
  tool: "#626262",
  error: "#cd3048",
  warning: "#a27612",
  ok: "#378e23",
  command: "#a27612",
  running: "#0082aa",
  link: "#2f64d2",
  path: "#c3691e",
  code: "#0f87a2",
  number: "#c3691e",
  string: "#378e23",
  type: "#0082aa",
  operator: "#cd3048",
  promptBorder: "#c8c8cd",
  promptBorderFocused: "#a5a5af",
  selectionBackground: "#2f64d2",
  selectionForeground: "#f5f5f5",
  userBackground: "#dedede",
  // Use the highlight gray here. The darker chrome gray reads as a code block
  // on a light base.
  pasteBackground: "#dedede",
  pasteForeground: "#444444",
  scrollbarTrack: "#eaeaea",
  scrollbarThumb: "#dedede",
  diffAddedBackground: "#daf2dc",
  diffRemovedBackground: "#f5dade",
});

/** `dark`/`light`, plus the `night`/`day` aliases. Anything else is no answer. */
function byName(raw: string | undefined): ThemeMode | undefined {
  const name = raw?.trim().toLowerCase();
  if (name === "dark" || name === "night") return "dark";
  if (name === "light" || name === "day") return "light";
  return undefined;
}

/**
 * Vim's `COLORFGBG` heuristic: background `0-6` and `8` are dark, `7` and
 * `9-15` are light. The background is the last field, and a non-numeric one
 * (`15;default`) means the terminal declined to say -- reading the foreground
 * instead would invert the answer.
 */
function byColorFgBg(raw: string | undefined): ThemeMode | undefined {
  const field = raw?.split(";").at(-1)?.trim();
  if (field === undefined || !/^\d+$/u.test(field)) return undefined;
  const background = Number(field);
  if (background <= 6 || background === 8) return "dark";
  return background <= 15 ? "light" : undefined;
}

/**
 * The palette to build the UI with, read once at startup.
 *
 * `UJI_THEME` is the explicit choice and `LC_UJI_THEME` its SSH-surviving
 * alias for setups configured to forward `LC_*` variables. `COLORFGBG` only
 * decides when neither is set. It is stamped once at shell start and inherited
 * unchanged, so it is a guess, not a live reading. An unset or unrecognized
 * source falls through to the next one, then to dark.
 *
 * Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-render/src/theme/env_appearance.rs
 */
export function resolveThemeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ThemeMode {
  return (
    byName(env["UJI_THEME"]) ??
    byName(env["LC_UJI_THEME"]) ??
    byColorFgBg(env["COLORFGBG"]) ??
    "dark"
  );
}

export function themeForMode(mode: ThemeMode): CliTheme {
  switch (mode) {
    case "dark":
      return DARK_THEME;
    case "light":
      return LIGHT_THEME;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
