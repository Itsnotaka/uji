/**
 * Semantic colors for every OpenTUI surface. Components consume roles from
 * this object; they do not own palettes or choose colors independently.
 */
export type CliTheme = Readonly<{
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

// Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager-render/src/theme/groknight.rs
export const THEME: CliTheme = Object.freeze({
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
