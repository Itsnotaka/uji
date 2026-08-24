/**
 * Fixed chrome copy and keycap strings for the TUI shell. Nothing here touches
 * a renderer, so tests can assert against them directly.
 */
import process from "node:process";

/**
 * The default key for each chat command, and the list of chat commands.
 * `src/keymap.ts` binds them and the hint rows below read their keycaps
 * straight off this record, so a rebind cannot leave the shell advertising a
 * key that no longer does anything.
 */
export const CHAT_KEYBINDS = {
  "chat.interrupt": "escape",
  "chat.focus.toggle": "tab",
  "chat.thinking.cycle": "shift+tab",
  "chat.model.next": "ctrl+p",
  "chat.model.previous": "ctrl+shift+p",
  "chat.editor.open": "ctrl+g",
  "chat.queue.open": "ctrl+q",
  "chat.queue.submit": "ctrl+return,ctrl+kpenter,ctrl+o",
  "chat.skills.open": "ctrl+s",
  // Every shortcut here takes a modifier, because a bare printable key is a
  // character first: binding `?` cost you the ability to send `?`, and hedging
  // it behind an empty composer only moved the hole to the start of a draft.
  // OpenCode makes the same call — its only bare-key bindings live in the diff
  // viewer, which has no text input:
  // https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/config/keybind.ts
  "chat.commands.open": "ctrl+k",
  "chat.history.previous": "up",
  "chat.history.next": "down",
} as const satisfies Readonly<Record<string, string>>;

export type ChatCommand = keyof typeof CHAT_KEYBINDS;

/** Keycaps read the way they are printed: `esc` and `enter`, not `escape` and `return`. */
const KEYCAP_NAMES: Readonly<Record<string, string>> = { escape: "esc", return: "enter" };

/** The first of a command's keys, which is the one worth advertising. */
export function keycap(command: ChatCommand): string {
  const [primary = ""] = CHAT_KEYBINDS[command].split(",");
  return primary.replace(/[^+]+$/u, (name) => KEYCAP_NAMES[name] ?? name);
}

export const IDLE_HINTS = `${keycap("chat.commands.open")} commands · ${keycap("chat.model.next")} model · ${keycap("chat.thinking.cycle")} thinking · ${keycap("chat.editor.open")} editor`;
export const BUSY_HINTS = `${keycap("chat.interrupt")} stop · enter steer · ${keycap("chat.queue.submit")} queue · ${keycap("chat.queue.open")} queued`;
export const CTRL_C_EXIT_HINT = "ctrl+c again to quit";
const COPY_SHORTCUT = process.platform === "darwin" ? "cmd+c" : "ctrl+c";
export const SCROLLBACK_HINTS = `${keycap("chat.focus.toggle")} prompt · ↑↓ scroll · ${COPY_SHORTCUT} copy`;
/** Escape still stops the run from up here, so the row has to say so. */
export const SCROLLBACK_BUSY_HINTS = `${keycap("chat.interrupt")} stop · ${SCROLLBACK_HINTS}`;
export const AUTH_URL_HINTS =
  process.platform === "darwin"
    ? "click link · drag select · cmd+c copy · ctrl+c cancel"
    : "click link · drag select · ctrl+c copy selection or cancel";
export const COMPOSER_PLACEHOLDER = "Plan, search, build anything";
export const BUSY_COMPOSER_PLACEHOLDER = "Add a follow-up";

/** Fixed transcript vocabulary and layout values. */
export const ACTIVITY_WORKING_LABEL = " Working";
export const ACTIVITY_THINKING_LABEL = " Thinking…";
export const ACTIVITY_THOUGHT_LABEL = " Thought";
export const ACTIVITY_WORKED_LABEL = "Worked";
export const ACTIVITY_STOPPED_LABEL = "! Stopped";
export const ACTIVITY_FAILED_LABEL = " Failed";
export const RESULT_PREVIEW_LINES = 3;
export const RESULT_TAIL_LINES = 3;
export const DIFF_PREVIEW_LINES = 120;
export const TOOL_INLINE_PREVIEW_LENGTH = 96;

/**
 * A legacy Windows console (bare ConHost) has no font for the box and arrow
 * glyphs. Modern terminals identify themselves, so anything unrecognized on
 * Windows takes the ASCII fallback. `UJI_FORCE_LEGACY_CONSOLE=1` forces it on
 * for testing, `=0` forces it off.
 *
 * Based on Grok Build's `decide_legacy_windows_console`:
 * https://github.com/xai-org/grok-build/blob/07b2f71/crates/codegen/xai-grok-pager-render/src/glyphs.rs
 */
const MODERN_TERMINALS = new Set([
  "alacritty",
  "ghostty",
  "kitty",
  "rio",
  "vscode",
  "wezterm",
  "windowsterminal",
  "zed",
]);

export function isLegacyWindowsConsole(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  const forced = env["UJI_FORCE_LEGACY_CONSOLE"];
  if (forced === "1" || forced === "true") return true;
  if (forced === "0" || forced === "false") return false;
  if (platform !== "win32") return false;
  if (env["WT_SESSION"] !== undefined) return false;
  const brand = (env["TERM_PROGRAM"] ?? "").toLowerCase().replaceAll(/[\s_-]/g, "");
  return !MODERN_TERMINALS.has(brand);
}

/** One-column chrome glyphs keep animated and settled rows aligned. */
export const GLYPHS = {
  /**
   * The composer's prompt and the highlighted menu row take the same arrow:
   * one mark means "this is where input goes", wherever it appears.
   */
  prompt: isLegacyWindowsConsole() ? ">" : "\u276f",
  bullet: "●",
  check: "✓",
  cross: "✗",
  diamond: "◆",
  gutter: "┃",
  rule: "─",
  separator: "│",
  frameBottomLeft: "╰",
  frameBottomRight: "╯",
  ellipsis: "…",
} as const;

export const SPACING = {
  block: 1,
  inset: 2,
  insetRight: 1,
} as const;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
export const SPINNER_INTERVAL_MS = 130;

export const WORKSPACE_TRUST_TITLE = "Workspace Trust Required";
export const WORKSPACE_TRUST_MESSAGE = "Uji can execute code and access files in this directory.";
export const WORKSPACE_TRUST_QUESTION = "Do you trust the contents of this directory?";
