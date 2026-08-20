import type { ThemeMode } from "@opentui/core";

export interface CliTheme {
  mode: ThemeMode;
  foreground: string;
  dim: string;
  user: string;
  assistant: string;
  thinking: string;
  tool: string;
  error: string;
  ok: string;
  code: string;
  number: string;
  string: string;
  type: string;
  operator: string;
  promptBorder: string;
  promptBorderFocused: string;
  selectionBackground: string;
  selectionForeground: string;
}

const DARK: CliTheme = {
  mode: "dark",
  foreground: "#e6edf3",
  dim: "#8b949e",
  user: "#58a6ff",
  assistant: "#e6edf3",
  thinking: "#8b949e",
  tool: "#d29922",
  error: "#ff7b72",
  ok: "#3fb950",
  code: "#d2a8ff",
  number: "#ffa657",
  string: "#7ee787",
  type: "#79c0ff",
  operator: "#ff7b72",
  promptBorder: "#484f58",
  promptBorderFocused: "#8b949e",
  selectionBackground: "#1f6feb",
  selectionForeground: "#ffffff",
};

const LIGHT: CliTheme = {
  mode: "light",
  foreground: "#24292f",
  dim: "#57606a",
  user: "#0969da",
  assistant: "#24292f",
  thinking: "#6e7781",
  tool: "#9a6700",
  error: "#cf222e",
  ok: "#1a7f37",
  code: "#8250df",
  number: "#953800",
  string: "#116329",
  type: "#0550ae",
  operator: "#8250df",
  promptBorder: "#b6bcc4",
  promptBorderFocused: "#6e7781",
  selectionBackground: "#dbeafe",
  selectionForeground: "#0a3069",
};

export function createTheme(mode: ThemeMode | null): CliTheme {
  return mode === "light" ? LIGHT : DARK;
}
