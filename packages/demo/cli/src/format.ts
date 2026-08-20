/**
 * Pure formatting and parsing helpers shared by the TUI and print mode.
 * Nothing here touches a renderer, so every function is unit-testable.
 */
import type { Entry } from "@june/core";
import type { Message } from "@june/schema";

export interface ParsedSlashCommand {
  name: string;
  argument: string;
}

/** Parse one slash command while preserving spaces inside its argument. */
export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/i.exec(input.trim());
  if (match === null) return undefined;
  return { name: (match[1] ?? "").toLowerCase(), argument: match[2]?.trim() ?? "" };
}

/**
 * `AgentEvent.tool_execution_start.args` is the raw JSON string the model
 * produced. Decode it once here; a malformed string is returned as-is so the
 * UI can still show what the model sent.
 */
export function parseToolArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DisplayDelta {
  kind: "text" | "reasoning";
  text: string;
}

/** Extract a displayable text or thinking delta from a Pi-style agent event. */
export function displayDelta(event: unknown): DisplayDelta | undefined {
  if (!isRecord(event)) return undefined;
  const assistantEvent = event["assistantMessageEvent"];
  if (isRecord(assistantEvent) && typeof assistantEvent["delta"] === "string") {
    if (assistantEvent["type"] === "text_delta") {
      return { kind: "text", text: assistantEvent["delta"] };
    }
    if (assistantEvent["type"] === "thinking_delta") {
      return { kind: "reasoning", text: assistantEvent["delta"] };
    }
  }
  return undefined;
}

function clip(text: string, max: number): string {
  const line = text.replaceAll("\n", "⏎");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
  /** One-line heading for the tool card: `$ cmd` for bash, `name path…` otherwise. */
  title: string;
  /** Full multi-line argument text worth showing under the heading, if any. */
  detail?: string;
}

/** The argument that best identifies a call: grep/find's pattern, else the path. */
const PRIMARY_KEYS = ["pattern", "path"] as const;

export function describeToolCall(toolName: string, rawArgs: unknown): ToolCallSummary {
  const args = parseToolArgs(rawArgs);
  if (toolName === "bash") {
    const command = isRecord(args) && typeof args["command"] === "string" ? args["command"] : "";
    return { title: `$ ${command === "" ? compactArgs(args) : clip(command, 120)}` };
  }
  if (!isRecord(args)) {
    const shown = compactArgs(args);
    return { title: shown === "" ? toolName : `${toolName} ${shown}` };
  }
  const primaryKey = PRIMARY_KEYS.find((key) => typeof args[key] === "string");
  const primary = primaryKey === undefined ? undefined : args[primaryKey];
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== primaryKey && key !== "content"),
  );
  const extra = compactArgs(rest);
  const head = [toolName, primary, extra].filter((part) => part !== undefined && part !== "");
  const summary: ToolCallSummary = { title: head.join(" ") };
  if (toolName === "write" && typeof args["content"] === "string") {
    summary.detail = args["content"];
  }
  return summary;
}

export interface Preview {
  text: string;
  omitted: number;
}

/** First `max` lines of `text`, plus how many lines were dropped. */
export function previewLines(text: string, max: number): Preview {
  const trimmed = text.replace(/\n+$/, "");
  if (trimmed === "") return { text: "", omitted: 0 };
  const lines = trimmed.split("\n");
  if (lines.length <= max) return { text: trimmed, omitted: 0 };
  return { text: lines.slice(0, max).join("\n"), omitted: lines.length - max };
}

export function omittedLabel(omitted: number): string {
  return omitted === 1 ? "… 1 more line" : `… ${String(omitted)} more lines`;
}

/** Unified diff string from an `edit` result, when the tool supplied one. */
export function diffFromDetails(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const diff = details["diff"];
  return typeof diff === "string" && diff !== "" ? diff : undefined;
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

/** Transcript item model shared by live events and restored sessions. */
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; callId: string; toolName: string; args: unknown; output?: string }
  | { kind: "note"; text: string };

/**
 * Turn a stored branch (oldest first) into transcript items. Tool calls and
 * their outputs are paired by tool-call id so a restored tool renders as one card.
 */
export function transcriptFromEntries(entries: Entry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const entry of entries) {
    if (entry.type === "model_change") {
      items.push({ kind: "note", text: `model → ${entry.modelId}` });
      continue;
    }
    if (entry.type === "thinking_level_change") {
      items.push({ kind: "note", text: `effort → ${entry.thinkingLevel}` });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      items.push({ kind: "user", text: partsText(message.content) });
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text !== "") items.push({ kind: "assistant", text: part.text });
        } else if (part.type === "thinking") {
          if (part.thinking !== "") items.push({ kind: "thinking", text: part.thinking });
        } else {
          const tool = {
            kind: "tool" as const,
            callId: part.id,
            toolName: part.name,
            args: part.arguments,
          };
          tools.set(part.id, tool);
          items.push(tool);
        }
      }
    } else {
      const output = partsText(message.content);
      const tool = tools.get(message.toolCallId);
      if (tool === undefined) {
        items.push({
          kind: "tool",
          callId: message.toolCallId,
          toolName: message.toolName,
          args: undefined,
          output,
        });
      } else {
        tool.output = output;
      }
    }
  }
  return items;
}

/** Everything the footer shows. Strings carry the meaning; color is decoration. */
export interface PowerlineState {
  runState: "idle" | "working" | "running tool" | "resuming";
  toolName?: string;
  workspace: string;
  branch?: string;
  dirty: boolean;
  provider: string;
  model: string;
  effort?: string;
  session: string;
  queued: number;
}

export interface PowerlineSegment {
  text: string;
  tone: "state" | "workspace" | "model" | "session" | "queue";
}

export function shortId(id: string): string {
  const durableSuffix = /-(s_[a-zA-Z0-9]+)$/.exec(id)?.[1];
  if (durableSuffix !== undefined) return durableSuffix;
  return id.length > 12 ? id.slice(0, 12) : id;
}

export function powerlineSegments(state: PowerlineState): PowerlineSegment[] {
  const stateText =
    state.runState === "running tool" && state.toolName !== undefined
      ? `running ${state.toolName}`
      : state.runState;
  const branch = state.branch === undefined ? "" : ` ${state.branch}${state.dirty ? "*" : ""}`;
  const segments: PowerlineSegment[] = [
    { text: stateText, tone: "state" },
    { text: `${state.workspace}${branch}`, tone: "workspace" },
    {
      text: `${state.provider}/${state.model}${state.effort === undefined ? "" : ` ${state.effort}`}`,
      tone: "model",
    },
    { text: state.session, tone: "session" },
  ];
  if (state.queued > 0) {
    segments.push({ text: `${String(state.queued)} queued`, tone: "queue" });
  }
  return segments;
}

export const POWERLINE_SEPARATOR = "│";

/** Plain-text rendering of the footer, for tests and non-color terminals. */
export function powerlineText(state: PowerlineState): string {
  return ` ${powerlineSegments(state)
    .map((segment) => segment.text)
    .join(` ${POWERLINE_SEPARATOR} `)}`;
}
