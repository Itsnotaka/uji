/**
 * Fixed chrome copy and keycap strings for the TUI shell. Nothing here touches
 * a renderer, so tests can assert against them directly.
 */
import process from "node:process";
import type { PendingItem } from "@uji-ai/core";

/**
 * The default key for each chat command, and the list of chat commands.
 * `src/keymap.ts` binds them and the hint rows below read their keycaps
 * straight off this record, so a rebind cannot leave the shell advertising a
 * key that no longer does anything.
 */
export const CHAT_KEYBINDS = {
  "chat.interrupt": "escape",
  "chat.scroll.page.up": "pageup",
  "chat.scroll.page.down": "pagedown",
  "chat.message.previous": "ctrl+up",
  "chat.message.next": "ctrl+down",
  "chat.thinking.cycle": "shift+tab",
  "chat.model.next": "ctrl+p",
  "chat.model.previous": "ctrl+shift+p",
  "chat.editor.open": "ctrl+g",
  "chat.queue.open": "ctrl+q",
  "chat.queue.submit": "ctrl+return,ctrl+kpenter",
  // Pi uses ctrl+o for this global toggle. It used to be Uji's unadvertised
  // queue fallback, which made the two commands impossible to bind together.
  "chat.tools.toggle": "ctrl+o",
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
export const CTRL_C_EXIT_HINT = "ctrl+c again to quit";
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
/**
 * The resolution of `formatDuration`, which prints tenths of a second. A span
 * under it has no label, so the row carries the word alone.
 */
export const MIN_REPORTED_DURATION_MS = 50;
export const RESULT_PREVIEW_LINES = 3;
export const RESULT_TAIL_LINES = 3;
export const TOOL_INLINE_PREVIEW_LENGTH = 96;
/** Newest calls kept visible under a collapsed tool call group. */
export const GROUP_TAIL_CALLS = 3;

/**
 * How the transcript draws consecutive tool calls. `auto` folds them into one
 * group per stretch of uninterrupted calls but keeps edits as full cards,
 * `compact` folds edits too, `detailed` never groups.
 */
export const TOOL_CALL_DISPLAY_MODES = ["auto", "compact", "detailed"] as const;
export type ToolCallDisplay = (typeof TOOL_CALL_DISPLAY_MODES)[number];

/**
 * A legacy Windows console (bare ConHost) has no font for the box and arrow
 * glyphs. Modern terminals identify themselves, so anything unrecognized on
 * Windows takes the ASCII fallback. `UJI_FORCE_LEGACY_CONSOLE=1` forces it on
 * for testing, `=0` forces it off.
 *
 * Based on https://github.com/xai-org/grok-build/blob/07b2f71/crates/codegen/xai-grok-pager-render/src/glyphs.rs
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

function isLegacyWindowsConsole(
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
  /**
   * Pending delivery, below. A steer cuts ahead of the run and a follow-up
   * falls in behind it, so the arrows point the way the message moves against
   * what is already going.
   */
  steer: isLegacyWindowsConsole() ? "^" : "\u2191",
  queue: isLegacyWindowsConsole() ? "v" : "\u2193",
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

/** A theme role rather than a color, so no surface picks a delivery's palette. */
interface DeliveryLabel {
  readonly glyph: string;
  readonly label: string;
  readonly tone: "accent" | "warning";
}

/**
 * The one place the shell names core's delivery modes. The pending gutter, the
 * queue picker, and the busy hint row all read it, so the key you press, the
 * word on the pending row, and the word in the picker cannot drift apart.
 *
 * Keyed by core's union so the compiler, not a `default` arm, is what catches a
 * delivery mode core adds later.
 */
export const DELIVERY: Readonly<Record<PendingItem["delivery"], DeliveryLabel>> = {
  steer: { glyph: GLYPHS.steer, label: "steer", tone: "accent" },
  queue: { glyph: GLYPHS.queue, label: "queue", tone: "warning" },
  // A follow-up with no run to wait for still falls in behind one.
  nextRun: { glyph: GLYPHS.queue, label: "next run", tone: "warning" },
};

/** Pressing a key and the state it produces read as the same word. */
export const BUSY_HINTS = `${keycap("chat.interrupt")} stop · enter ${DELIVERY.steer.label} · ${keycap("chat.queue.submit")} ${DELIVERY.queue.label}`;

/**
 * The gutter's last row: the key that opens what is waiting, plus any rows the
 * height cap had to hide. Stated once there, which is why `BUSY_HINTS` above
 * does not repeat it. It names the surface rather than one of its actions,
 * because the menu behind it sends, edits, and deletes.
 */
export function pendingHint(hidden: number): string {
  const open = `${keycap("chat.queue.open")} pending`;
  return hidden > 0 ? `+${String(hidden)} more \u00b7 ${open}` : open;
}

export const WORKSPACE_TRUST_TITLE = "Workspace Trust Required";
export const WORKSPACE_TRUST_MESSAGE = "Uji can execute code and access files in this directory.";
export const WORKSPACE_TRUST_QUESTION = "Do you trust the contents of this directory?";
