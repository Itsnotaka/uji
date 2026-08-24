/**
 * Styling for the command surface outside the TUI: help, login, logout,
 * status, update, errors. Every builder takes an explicit `color` flag so
 * tests assert against plain strings; the exported wrappers read the real
 * terminal state lazily. Piped or redirected output stays unstyled, so
 * scripts keep parsing bare text.
 */
import process from "node:process";
import { GLYPHS } from "./constants.ts";
import { VERSION } from "./version.ts";

/** True only for an interactive terminal that has not opted out of color. */
export function ansiEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (stream.isTTY !== true) return false;
  const noColor = process.env["NO_COLOR"];
  if (noColor !== undefined && noColor !== "") return false;
  return process.env["CI"] !== "true";
}

const RESET = "\x1b[0m";

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}${RESET}` : text;
}

export function bold(text: string): string {
  return paint(ansiEnabled(), "1", text);
}

export function dim(text: string): string {
  return paint(ansiEnabled(), "2", text);
}

export function green(text: string): string {
  return paint(ansiEnabled(), "32", text);
}

export function yellow(text: string): string {
  return paint(ansiEnabled(), "33", text);
}

export function red(text: string): string {
  return paint(ansiEnabled(), "31", text);
}

export function cyan(text: string): string {
  return paint(ansiEnabled(), "36", text);
}

/**
 * One help row: the command column is padded to a fixed width so every
 * description starts on the same column, whatever the terminal.
 */
export interface HelpRow {
  command: string;
  description: string;
}

const HELP_COMMAND_WIDTH = 31;

function helpRowSpecs(): readonly HelpRow[] {
  return [
    { command: "uji", description: "open the full-screen TUI" },
    {
      command: "uji --resume [<session-id>]",
      description: "resume the latest or specified session",
    },
    { command: "uji login [provider]", description: "sign in (default: openai-codex)" },
    { command: "uji logout [provider]", description: "remove the stored credential" },
    { command: "uji status", description: "list stored credentials" },
    {
      command: "uji update [version|--check]",
      description: "install the latest release, a given one, or only check",
    },
    { command: "uji --version", description: "print the installed version" },
    { command: "uji -p [--json] [--quiet] [--resume] [prompt]", description: "" },
  ];
}

function renderHelpRow(row: HelpRow, color: boolean): string {
  const spaces = " ".repeat(Math.max(0, HELP_COMMAND_WIDTH - row.command.length));
  const styled = paint(color, "1", row.command) + spaces;
  if (row.description === "") return `  ${styled}`;
  return `  ${styled}${paint(color, "2", row.description)}`;
}

/**
 * The `--help` screen. Colored on a TTY, plain otherwise; the plain form is
 * what lands in stderr usage messages, so it must read fine without color.
 */
export function renderHelp(color: boolean = ansiEnabled()): string {
  const head = `${paint(color, "1", "uji")} ${paint(color, "2", `v${VERSION} · durable agent sessions in your terminal`)}`;
  const lines = [
    head,
    "",
    `  ${paint(color, "2", "usage:")}`,
    `  ${paint(color, "1", "uji")} ${paint(color, "2", "[command] [flags]")}`,
    "",
    `  ${paint(color, "2", "commands:")}`,
    ...helpRowSpecs().map((row) => renderHelpRow(row, color)),
    "",
    `  ${paint(color, "2", "flags:")}`,
    renderHelpRow(
      { command: "--provider <id>", description: "override the saved provider" },
      color,
    ),
    renderHelpRow({ command: "--model <id>", description: "override the saved model" }, color),
    renderHelpRow({ command: "--effort <level>", description: "set thinking level" }, color),
    "",
    `  ${paint(color, "2", "a missing -p prompt is read from stdin")}`,
  ];
  return lines.join("\n");
}

/** Width of the widest label, so detail columns start on one column. */
export function columnWidth(labels: readonly string[]): number {
  return labels.reduce((max, label) => Math.max(max, label.length), 0);
}

/** One aligned `label  detail` row; `glyph` prefixes the line when given. */
export function fieldRow(
  label: string,
  detail: string,
  width: number,
  color: boolean,
  glyph = "",
): string {
  const pad = " ".repeat(Math.max(0, width - label.length));
  const lead = glyph === "" ? "  " : `${glyph} `;
  return `${lead}${paint(color, "1", label)}${pad}  ${paint(color, "2", detail)}`;
}

/** `45%` progress lines collapse into one rewritten TTY row instead of a stack. */
export function isPercentLine(line: string): boolean {
  return /^\d{1,3}%$/u.test(line.trim());
}

/** A finished step in the gutter-glyph vocabulary: ✓ done, ! warning, ✗ failure. */
export function statusGlyph(kind: "ok" | "warn" | "fail", color: boolean): string {
  if (kind === "ok") return paint(color, "32", GLYPHS.check);
  if (kind === "warn") return paint(color, "33", GLYPHS.bullet);
  return paint(color, "31", GLYPHS.cross);
}
