/**
 * Pure formatting and parsing helpers shared by the TUI and print mode.
 * Nothing here touches a renderer, so every function is unit-testable.
 */
import { toJsonValue, type Entry, type ThinkingLevel } from "@uji-ai/core";
import type { JsonValue, Message, UserMessage } from "@uji-ai/schema";
import { parsePatch, type StructuredPatch } from "diff";
import { GLYPHS, SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "./constants.ts";
import { displayWidth, truncateDisplay } from "./width.ts";

export interface ParsedSlashCommand {
  name: string;
  argument: string;
}

export type ComposerSubmission =
  | { kind: "empty" }
  | { kind: "command"; command: ParsedSlashCommand }
  | { kind: "prompt"; text: string };

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSlashCommandNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return isAsciiLetter(character) || (code >= 48 && code <= 57) || character === "-";
}

/** Parse one slash command while preserving spaces inside its argument. */
export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const value = input.trim();
  const first = value[1];
  if (
    !value.startsWith("/") ||
    first === undefined ||
    first === "-" ||
    !isSlashCommandNameCharacter(first)
  ) {
    return undefined;
  }
  if (value.includes("\n") || value.includes("\r")) return undefined;

  let nameEnd = 2;
  while (nameEnd < value.length) {
    const character = value[nameEnd];
    if (character === undefined || character.trim() === "") break;
    if (!isSlashCommandNameCharacter(character)) return undefined;
    nameEnd += 1;
  }

  return {
    name: value.slice(1, nameEnd).toLowerCase(),
    argument: value.slice(nameEnd).trim(),
  };
}

/** Classify composer text once at the chat-or-command boundary. */
export function parseComposerSubmission(input: string): ComposerSubmission {
  const text = input.trim();
  if (text === "") return { kind: "empty" };
  const command = parseSlashCommand(text);
  return command === undefined ? { kind: "prompt", text } : { kind: "command", command };
}

/**
 * `AgentEvent.tool_execution_start.args` is the raw JSON string the model
 * produced. Decode it once here; a malformed string is returned as-is so the
 * UI can still show what the model sent.
 */
export function parseToolArgs(args: unknown): JsonValue | undefined {
  if (args === undefined) return undefined;
  if (typeof args !== "string") return toJsonValue(args);
  try {
    return toJsonValue(JSON.parse(args));
  } catch {
    return args;
  }
}

interface JsonObject {
  readonly [key: string]: JsonValue;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, max: number): string {
  const line = text.replaceAll("\n", "⏎");
  return truncateDisplay(line, max, GLYPHS.ellipsis);
}

/** A path inside the working directory reads better without the prefix. */
export function relativePath(path: string, cwd: string): string {
  if (!path.startsWith(`${cwd}/`)) return path;
  return path.slice(cwd.length + 1);
}

/** `key=value` pairs, strings unquoted, one line, for non-bash tool titles. */
export function compactArgs(args: unknown, max = 96): string {
  if (!isRecord(args)) {
    if (args === undefined) return "";
    if (typeof args === "string") return clip(args, max);
    if (typeof args === "symbol") {
      return clip(args.description === undefined ? "Symbol()" : `Symbol(${args.description})`, max);
    }
    if (typeof args === "bigint") return clip(`${args.toString()}n`, max);
    if (typeof args === "function") return clip(`[function ${args.name || "anonymous"}]`, max);
    return clip(JSON.stringify(args), max);
  }
  const pairs = Object.entries(args).map(([key, value]) => {
    const shown = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}=${clip(shown ?? "", 40)}`;
  });
  return clip(pairs.join(" "), max);
}

export interface ToolCallSummary {
  /** The action, capitalised: `Read`, `Run`, `Search`. */
  verb: string;
  /** What the action acts on: a path, a command, a pattern. */
  operand: string;
  /** Which colour the operand gets. */
  operandKind: "path" | "command" | "pattern" | "plain";
  /** Trailing arguments that qualify the call, shown dim. */
  qualifier?: string;
  /** One line, unstyled, for print mode. */
  title: string;
  /** Full multi-line argument text worth showing under the heading, if any. */
  body?: string;
  /** Source path, when the call names one, for syntax highlighting. */
  path?: string;
}

/**
 * A verb per tool, so every heading reads the same way: verb, operand, qualifier.
 * Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool
 */
const VERBS: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Run",
  grep: "Search",
  find: "Find",
  ls: "List",
};

/** The argument that best identifies a call: grep/find's pattern, else the path. */
const PRIMARY_KEYS = ["pattern", "path"] as const;

/**
 * A heading qualifier only carries scalars. Structured arguments — an `edits`
 * array, a nested options object — say nothing at a glance and push the operand
 * off the row.
 */
function isHeadingValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function summary(parts: Omit<ToolCallSummary, "title">): ToolCallSummary {
  const title = [parts.verb, parts.operand, parts.qualifier]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return { ...parts, title };
}

export function describeToolCall(toolName: string, rawArgs: unknown): ToolCallSummary {
  const args = parseToolArgs(rawArgs);
  const verb = VERBS[toolName] ?? toolName;
  if (toolName === "bash") {
    const command = isRecord(args) && typeof args["command"] === "string" ? args["command"] : "";
    return summary({
      verb,
      operand: command === "" ? compactArgs(args) : clip(command, 120),
      operandKind: "command",
    });
  }
  if (!isRecord(args)) {
    return summary({ verb, operand: compactArgs(args), operandKind: "plain" });
  }
  const primaryKey = PRIMARY_KEYS.find((key) => typeof args[key] === "string");
  const primary = primaryKey === undefined ? "" : String(args[primaryKey]);
  const rest = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => key !== primaryKey && key !== "content" && isHeadingValue(value),
    ),
  );
  const path = typeof args["path"] === "string" ? args["path"] : undefined;
  return summary({
    verb,
    operand: primary,
    operandKind: primaryKey === "pattern" ? "pattern" : "path",
    qualifier: compactArgs(rest),
    body: toolName === "write" && typeof args["content"] === "string" ? args["content"] : undefined,
    ...(path === undefined ? {} : { path }),
  });
}

/** How long an operation took, read as a duration rather than a clock. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${String(Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(Math.floor(seconds % 60))}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60)}m`;
}

/** The spinner frame for a run that started `elapsedMs` ago. */
export function spinnerFrame(elapsedMs: number): string {
  const index = Math.floor(elapsedMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0];
}

/** What a finished tool produced, for the dim tail of its heading. */
export function resultSummary(text: string): string | undefined {
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed === "") return undefined;
  const lines = trimmed.split("\n").length;
  return lines === 1 ? undefined : `${String(lines)} lines`;
}

export interface Preview {
  text: string;
  omitted: number;
}

/**
 * A capped view of `text`: the first `max` lines, or — when `tail` is given —
 * the first `max` and the last `tail` with the middle dropped, so the end of a
 * command's output stays visible.
 */
export function previewLines(text: string, max: number, tail = 0): Preview {
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed === "") return { text: "", omitted: 0 };
  const lines = trimmed.split("\n");
  if (lines.length <= max + tail) return { text: trimmed, omitted: 0 };
  const head = lines.slice(0, max);
  const omitted = lines.length - max - tail;
  if (tail === 0) return { text: head.join("\n"), omitted };
  return {
    text: [...head, omittedLabel(omitted), ...lines.slice(-tail)].join("\n"),
    omitted: 0,
  };
}

export function omittedLabel(omitted: number): string {
  return omitted === 1
    ? `${GLYPHS.ellipsis} 1 more line`
    : `${GLYPHS.ellipsis} ${String(omitted)} more lines`;
}

/** `+added -removed` line counts from a unified patch, for a tool heading. */
export function diffStat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Unified patch from an `edit` result. The tool also ships `details.diff`, but
 * that is a display string with line numbers baked in (`+12 text`), which no
 * unified-diff parser accepts; `details.patch` is the real patch.
 */
export function diffFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const patch = details["patch"];
  if (typeof patch === "string" && patch !== "") return patch;
  const diff = details["diff"];
  return typeof diff === "string" && diff.startsWith("---") ? diff : undefined;
}

export interface OutputDiffFile {
  patch: string;
  path?: string;
}

export interface OutputDiff {
  files: OutputDiffFile[];
  before?: string;
  after?: string;
}

function substantivePatch(patch: StructuredPatch): boolean {
  return (
    patch.hunks.length > 0 ||
    patch.isBinary === true ||
    patch.isRename === true ||
    patch.isCopy === true ||
    patch.isCreate === true ||
    patch.isDelete === true ||
    patch.oldMode !== patch.newMode
  );
}

function outputDiffStart(text: string): number | undefined {
  const git = /(^|\n)diff --git [^\n]+/.exec(text);
  const unified = /(^|\n)--- [^\n]+\n\+\+\+ [^\n]+/.exec(text);
  const starts = [git, unified]
    .filter((match) => match !== null)
    .map((match) => match.index + (match[1]?.length ?? 0));
  return starts.length === 0 ? undefined : Math.min(...starts);
}

function diffPath(patch: StructuredPatch): string | undefined {
  const named =
    patch.newFileName !== undefined && patch.newFileName !== "/dev/null"
      ? patch.newFileName
      : patch.oldFileName;
  if (named === undefined || named === "/dev/null") return undefined;
  return patch.isGit === true && /^[ab]\//.test(named) ? named.slice(2) : named;
}

function outputDiffFiles(patch: string, parsed: readonly StructuredPatch[]): OutputDiffFile[] {
  const starts = [...patch.matchAll(/^diff --git [^\n]+/gm)].flatMap((match) =>
    match.index === undefined ? [] : [match.index],
  );
  if (starts.length !== parsed.length || starts.length === 0) {
    const path = parsed.length === 1 && parsed[0] !== undefined ? diffPath(parsed[0]) : undefined;
    return [{ patch, ...(path === undefined ? {} : { path }) }];
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? patch.length;
    const path = parsed[index] === undefined ? undefined : diffPath(parsed[index]);
    return {
      patch: patch.slice(start, end).replace(/\n+$/, ""),
      ...(path === undefined ? {} : { path }),
    };
  });
}

function trimSection(text: string): string | undefined {
  const trimmed = text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Find a complete unified diff inside tool output. Shell calls often append a
 * status or diff-stat command, so try progressively shorter prefixes and keep
 * any text before or after the patch as ordinary output.
 */
export function diffFromOutput(text: string): OutputDiff | undefined {
  const start = outputDiffStart(text);
  if (start === undefined) return undefined;
  const before = trimSection(text.slice(0, start));
  const lines = text.slice(start).split("\n");
  for (let end = lines.length; end > 0; end--) {
    const patch = lines.slice(0, end).join("\n").replace(/\n+$/, "");
    let parsed: StructuredPatch[];
    try {
      parsed = parsePatch(patch);
    } catch {
      continue;
    }
    if (parsed.length === 0 || !parsed.some(substantivePatch)) continue;
    const after = trimSection(lines.slice(end).join("\n"));
    return {
      files: outputDiffFiles(patch, parsed),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    };
  }
  return undefined;
}

/** Flatten wire content parts to display text; images become a marker. */
export function partsText(content: Message["content"] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "image") return "[image]";
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      return "";
    })
    .join("");
}

/** One display line from possibly multi-line text, for compact rows. */
export function oneLine(text: string): string {
  return text.replaceAll("\r", "").replaceAll("\n", "⏎").trim();
}

export interface TranscriptUserPart {
  kind: "user";
  entryId: string;
  parentId: string | null;
  content: UserMessage["content"];
}

export type TranscriptTurnPart =
  | TranscriptUserPart
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      callId: string;
      toolName: string;
      args: unknown;
      output?: string;
      details?: unknown;
      isError?: boolean;
    }
  | { kind: "note"; text: string }
  | { kind: "compaction"; summary: string; tokensBefore: number };

export type TranscriptTurnOutcome = "completed" | "aborted" | "failed";

/** One durable visual owner per conversation turn. */
export type TranscriptItem =
  | {
      kind: "turn";
      id: string;
      entryIds: string[];
      parts: TranscriptTurnPart[];
      outcome: TranscriptTurnOutcome;
    }
  | { kind: "note"; entryIds: string[]; text: string }
  | {
      kind: "compaction";
      entryIds: string[];
      summary: string;
      tokensBefore: number;
    };

/**
 * Turn a stored branch (oldest first) into transcript items. Tool calls and
 * their outputs are paired by tool-call id so a restored tool renders as one card.
 */
export function transcriptFromEntries(entries: readonly Entry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptTurnPart, { kind: "tool" }>>();
  let turn: Extract<TranscriptItem, { kind: "turn" }> | undefined;

  const ensureTurn = (id: string): Extract<TranscriptItem, { kind: "turn" }> => {
    if (turn !== undefined) return turn;
    turn = { kind: "turn", id, entryIds: [], parts: [], outcome: "completed" };
    items.push(turn);
    return turn;
  };

  const addEntry = (owner: Extract<TranscriptItem, { kind: "turn" }>, id: string): void => {
    if (!owner.entryIds.includes(id)) owner.entryIds.push(id);
  };

  for (const entry of entries) {
    if (entry.type === "model_change" || entry.type === "thinking_level_change") {
      continue;
    }
    if (entry.type === "compaction") {
      const preview = previewLines(entry.summary, 40);
      const checkpoint = {
        kind: "compaction",
        summary:
          preview.omitted === 0
            ? preview.text
            : `${preview.text}\n${omittedLabel(preview.omitted)}`,
        tokensBefore: entry.tokensBefore,
      } as const;
      if (turn === undefined) items.push({ ...checkpoint, entryIds: [entry.id] });
      else {
        addEntry(turn, entry.id);
        turn.parts.push(checkpoint);
      }
      continue;
    }
    if (entry.type === "custom") {
      const data = isRecord(entry.data) ? entry.data : undefined;
      const providerId = data?.["providerId"];
      const cwd = data?.["cwd"];
      if (entry.customType === "provider_change" && typeof providerId === "string") {
        items.push({ kind: "note", entryIds: [entry.id], text: `Provider → ${providerId}` });
        turn = undefined;
        tools.clear();
      } else if (entry.customType === "cwd_change" && typeof cwd === "string") {
        items.push({ kind: "note", entryIds: [entry.id], text: `Directory → ${cwd}` });
        turn = undefined;
        tools.clear();
      }
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      turn = {
        kind: "turn",
        id: entry.id,
        entryIds: [entry.id],
        outcome: "completed",
        parts: [
          {
            kind: "user",
            entryId: entry.id,
            parentId: entry.parentId,
            content: message.content,
          },
        ],
      };
      items.push(turn);
      tools.clear();
    } else if (message.role === "assistant") {
      const outcome: TranscriptTurnOutcome =
        message.stopReason === "aborted"
          ? "aborted"
          : message.stopReason === "error" || message.errorMessage !== undefined
            ? "failed"
            : "completed";
      const hasVisibleContent = message.content.some(
        (part) =>
          part.type === "toolCall" ||
          (part.type === "text" && part.text !== "") ||
          (part.type === "thinking" && part.thinking !== ""),
      );
      if (!hasVisibleContent && outcome === "completed") {
        continue;
      }
      const owner = ensureTurn(entry.id);
      addEntry(owner, entry.id);
      owner.outcome = outcome;
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text !== "") {
            owner.parts.push({ kind: "assistant", text: part.text });
          }
        } else if (part.type === "thinking") {
          if (part.thinking !== "") {
            owner.parts.push({ kind: "thinking", text: part.thinking });
          }
        } else {
          const tool = {
            kind: "tool" as const,
            callId: part.id,
            toolName: part.name,
            args: part.arguments,
          };
          tools.set(part.id, tool);
          owner.parts.push(tool);
        }
      }
      if (message.stopReason !== "aborted" && message.errorMessage !== undefined) {
        owner.parts.push({ kind: "note", text: `Error: ${message.errorMessage}` });
      }
    } else {
      const owner = ensureTurn(entry.id);
      addEntry(owner, entry.id);
      const output = partsText(message.content);
      const tool = tools.get(message.toolCallId);
      if (tool === undefined) {
        owner.parts.push({
          kind: "tool",
          callId: message.toolCallId,
          toolName: message.toolName,
          args: undefined,
          output,
          details: message.details,
          isError: message.isError,
        });
      } else {
        tool.output = output;
        tool.details = message.details;
        tool.isError = message.isError;
      }
    }
  }
  return items;
}

/** Locate the top-level visual owner for a durable entry. */
export function transcriptItemIndex(items: readonly TranscriptItem[], entryId: string): number {
  return items.findIndex((item) => item.entryIds.includes(entryId));
}

/** Composer metadata. Run state is retained for shell behavior, not rendered. */
export interface PowerlineState {
  runState: "idle" | "working" | "running tool" | "compacting" | "resuming";
  workspace: string;
  branch?: string;
  dirty: boolean;
  model: string;
  effort?: ThinkingLevel;
  /** Priority processing is on. */
  fast: boolean;
  queued: number;
  /** Tokens reported by the last settled assistant turn. */
  tokens?: number;
  /** Estimated share of the model's context window in use, whole percent. */
  pct?: number;
}

export interface PowerlineSegment {
  text: string;
  tone: "workspace" | "model" | "effort" | "queue" | "usage";
}

export function shortId(id: string): string {
  const durableSuffix = /-(s_[a-zA-Z0-9]+)$/.exec(id)?.[1];
  if (durableSuffix !== undefined) return durableSuffix;
  return id.length > 12 ? id.slice(0, 12) : id;
}

/** `12340` → `12.3k`; whole counts below a thousand stay bare. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function powerlineSegments(state: PowerlineState): PowerlineSegment[] {
  const branch = state.branch === undefined ? "" : ` ${state.branch}${state.dirty ? "*" : ""}`;
  const effort: PowerlineSegment[] =
    state.effort === undefined
      ? []
      : [{ text: `${state.effort}${state.fast ? " fast" : ""}`, tone: "effort" }];
  const usage: PowerlineSegment[] = [];
  if (state.tokens !== undefined && state.tokens > 0) {
    usage.push({
      text: `${formatTokens(state.tokens)} tokens${state.pct === undefined ? "" : ` · ${String(state.pct)}% context`}`,
      tone: "usage",
    });
  }
  const segments: PowerlineSegment[] = [
    { text: `${state.workspace}${branch}`, tone: "workspace" },
    { text: state.model, tone: "model" },
    ...effort,
    ...usage,
  ];
  if (state.queued > 0) {
    segments.push({ text: `${String(state.queued)} queued`, tone: "queue" });
  }
  return segments;
}

function joinSegments(segments: readonly PowerlineSegment[]): string {
  return ` ${segments.map((segment) => segment.text).join(` ${GLYPHS.separator} `)}`;
}

/** Drop low-priority metadata as the terminal narrows. Model survives. */
export function fitPowerlineSegments(
  segments: readonly PowerlineSegment[],
  maxWidth: number,
): PowerlineSegment[] {
  let kept = [...segments];
  const droppable: PowerlineSegment["tone"][] = ["usage", "workspace", "queue", "effort"];
  for (const tone of droppable) {
    if (displayWidth(joinSegments(kept)) <= maxWidth) break;
    kept = kept.filter((segment) => segment.tone !== tone);
  }
  return kept;
}

/** Plain-text status rendering. Semantic color is added by the TUI renderer. */
export function powerlineText(state: PowerlineState, maxWidth?: number): string {
  const segments = powerlineSegments(state);
  if (maxWidth === undefined) return joinSegments(segments);
  const text = joinSegments(fitPowerlineSegments(segments, maxWidth));
  return truncateDisplay(text, Math.max(0, maxWidth));
}

export interface HintGroup {
  key: string;
  label: string;
}

/** Hint rows join their groups with a spaced middle dot. */
const HINT_SEPARATOR = " \u00b7 ";

/**
 * Split a hint row into keycaps and what they do. Every hint string is written
 * `<keycap> <what it does>`, so the first token is the cap and the rest is the
 * description — that lets the renderer give the two different weights without
 * the constants carrying markup.
 */
export function hintGroups(text: string): HintGroup[] {
  const groups: HintGroup[] = [];
  for (const chunk of text.split(HINT_SEPARATOR)) {
    const trimmed = chunk.trim();
    if (trimmed === "") continue;
    const space = trimmed.indexOf(" ");
    if (space < 0) groups.push({ key: trimmed, label: "" });
    else groups.push({ key: trimmed.slice(0, space), label: trimmed.slice(space + 1) });
  }
  return groups;
}
