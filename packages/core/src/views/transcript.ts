import type { Entry, JsonValue } from "../harness/session/types.ts";

type MessageEntry = Extract<Entry, { type: "message" }>;
type UserMessage = Extract<MessageEntry["message"], { role: "user" }>;
type CompactionEntry = Extract<Entry, { type: "compaction" }>;
type BranchSummaryEntry = Extract<Entry, { type: "branch_summary" }>;
type ModelChangeEntry = Extract<Entry, { type: "model_change" }>;
type CustomEntry = Extract<Entry, { type: "custom" }>;

export interface UserTurnPart {
  kind: "user";
  entryId: string;
  parentId: string | null;
  content: UserMessage["content"];
}

export type ToolTurnPart = {
  kind: "tool";
  callId: string;
  toolName: string;
  /** Absent when the call itself is not on this branch and only its result is. */
  args?: JsonValue;
  result?: {
    entryId: string;
    output: string;
    details?: JsonValue;
    title?: string;
    isError: boolean;
  };
};

export type TurnPart =
  | UserTurnPart
  | { kind: "assistant"; entryId: string; contentIndex: number; text: string }
  | { kind: "thinking"; entryId: string; contentIndex: number; text: string }
  | ToolTurnPart
  | { kind: "note"; entryId: string; text: string };

export type TurnOutcome = "completed" | "aborted" | "failed";

export type Turn =
  | {
      kind: "turn";
      id: string;
      parts: TurnPart[];
      outcome: TurnOutcome;
      /** When the turn's first entry landed. */
      startedAt: number;
      /**
       * How long the turn's entries span. A turn of one entry spans zero,
       * which is a turn nothing followed rather than a turn that took no time.
       * The number is the record's, so every client that draws the turn reports
       * the same one however many times the transcript is rebuilt.
       */
      durationMs: number;
    }
  | { kind: "compaction"; entry: CompactionEntry }
  | { kind: "branch_summary"; entry: BranchSummaryEntry }
  | { kind: "model_change"; entry: ModelChangeEntry }
  | { kind: "custom"; entry: CustomEntry };

type ConversationTurn = Extract<Turn, { kind: "turn" }>;

/** Stable semantic identity for one part, independent of any renderer. */
export function turnPartId(part: TurnPart): string {
  switch (part.kind) {
    case "user":
      return `user:${part.entryId}`;
    case "assistant":
    case "thinking":
      return `${part.kind}:${part.entryId}:${String(part.contentIndex)}`;
    case "tool":
      return `tool:${part.callId}`;
    case "note":
      return `note:${part.entryId}`;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

/**
 * Incremental transcript state. `seq` is the last entry folded: a branch's
 * entries carry strictly increasing seqs, so an entry at or below it is a
 * repeat, which happens when the in-process harness and the durable session
 * watcher observe the same commit.
 */
export interface TranscriptState {
  readonly items: readonly Turn[];
  readonly seq: number;
}

export const EMPTY_TRANSCRIPT: TranscriptState = { items: [], seq: -1 };

function toolResultText(entry: MessageEntry): string {
  if (entry.message.role !== "toolResult") return "";
  return entry.message.content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          return "[image]";
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    })
    .join("");
}

function outcomeFrom(entry: MessageEntry): TurnOutcome {
  if (entry.message.role !== "assistant") return "completed";
  if (entry.message.stopReason === "aborted") return "aborted";
  if (entry.message.stopReason === "error" || entry.message.errorMessage !== undefined) {
    return "failed";
  }
  return "completed";
}

/**
 * Whitespace is not content: providers pad text and thinking blocks around
 * tool calls, and a part that draws nothing should not reach a client as one.
 */
function hasVisibleAssistantContent(entry: MessageEntry): boolean {
  if (entry.message.role !== "assistant") return false;
  return entry.message.content.some((part) => {
    switch (part.type) {
      case "toolCall":
        return true;
      case "text":
        return part.text.trim() !== "";
      case "thinking":
        return part.thinking.trim() !== "";
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  });
}

/**
 * The turn this entry lands in: a fresh copy of the open tail, replaced in
 * `items`, or a new turn pushed onto it. `items` is the caller's own copy, so
 * writing into it here keeps the fold pure from the outside. Every entry that
 * lands in a turn also dates it, and a host clock can step backwards mid-turn,
 * so the span only ever grows.
 */
function landingTurn(items: Turn[], entry: Entry): ConversationTurn {
  const last = items.at(-1);
  const turn: ConversationTurn =
    last?.kind === "turn"
      ? {
          ...last,
          parts: [...last.parts],
          durationMs: Math.max(last.durationMs, entry.timestamp - last.startedAt),
        }
      : {
          kind: "turn",
          id: entry.id,
          parts: [],
          outcome: "completed",
          startedAt: entry.timestamp,
          durationMs: 0,
        };
  items[last?.kind === "turn" ? items.length - 1 : items.length] = turn;
  return turn;
}

/** A request opens a turn whatever the entries before it were doing. */
function appendUser(items: Turn[], entry: MessageEntry, message: UserMessage): void {
  items.push({
    kind: "turn",
    id: entry.id,
    outcome: "completed",
    startedAt: entry.timestamp,
    durationMs: 0,
    parts: [
      { kind: "user", entryId: entry.id, parentId: entry.parentId, content: message.content },
    ],
  });
}

function appendAssistant(
  items: Turn[],
  entry: MessageEntry,
  message: Extract<MessageEntry["message"], { role: "assistant" }>,
): void {
  const outcome = outcomeFrom(entry);
  if (!hasVisibleAssistantContent(entry) && outcome === "completed") return;
  const turn = landingTurn(items, entry);
  turn.outcome = outcome;
  for (const [contentIndex, part] of message.content.entries()) {
    switch (part.type) {
      case "text":
        if (part.text.trim() !== "") {
          turn.parts.push({ kind: "assistant", entryId: entry.id, contentIndex, text: part.text });
        }
        break;
      case "thinking":
        if (part.thinking.trim() !== "") {
          turn.parts.push({
            kind: "thinking",
            entryId: entry.id,
            contentIndex,
            text: part.thinking,
          });
        }
        break;
      case "toolCall":
        turn.parts.push({
          kind: "tool",
          callId: part.id,
          toolName: part.name,
          args: part.arguments,
        });
        break;
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }
  if (message.stopReason !== "aborted" && message.errorMessage !== undefined) {
    turn.parts.push({ kind: "note", entryId: entry.id, text: `Error: ${message.errorMessage}` });
  }
}

/** A result settles the call it answers, or stands alone when the call is not on this branch. */
function appendToolResult(
  items: Turn[],
  entry: MessageEntry,
  message: Extract<MessageEntry["message"], { role: "toolResult" }>,
): void {
  const turn = landingTurn(items, entry);
  const result = {
    entryId: entry.id,
    output: toolResultText(entry),
    isError: message.isError,
    // SAFETY: entry payloads cross toJsonValue at write; only pi's ported schema type is looser.
    ...(message.details === undefined ? {} : { details: message.details as JsonValue }),
    ...(message.title === undefined ? {} : { title: message.title }),
  };
  const index = turn.parts.findIndex(
    (part) => part.kind === "tool" && part.callId === message.toolCallId,
  );
  const call = turn.parts[index];
  if (call?.kind === "tool") {
    turn.parts[index] = { ...call, result };
    return;
  }
  turn.parts.push({
    kind: "tool",
    callId: message.toolCallId,
    toolName: message.toolName,
    result,
  });
}

/**
 * Fold one committed entry into the transcript. The one incremental path: a
 * live client appends as entries commit, a restore folds the branch, and both
 * arrive at the same items. A compaction is appended like any other marker;
 * it cuts model context, never the turns before it. Repeating an entry is a
 * no-op.
 */
export function appendTranscriptEntry(state: TranscriptState, entry: Entry): TranscriptState {
  if (entry.seq <= state.seq) return state;
  const items = [...state.items];
  switch (entry.type) {
    case "message": {
      const { message } = entry;
      switch (message.role) {
        case "user":
          appendUser(items, entry, message);
          break;
        case "assistant":
          appendAssistant(items, entry, message);
          break;
        case "toolResult":
          appendToolResult(items, entry, message);
          break;
        default: {
          const _exhaustive: never = message;
          return _exhaustive;
        }
      }
      break;
    }
    case "compaction":
      items.push({ kind: "compaction", entry });
      break;
    case "branch_summary":
      items.push({ kind: "branch_summary", entry });
      break;
    case "model_change":
      items.push({ kind: "model_change", entry });
      break;
    case "custom":
      items.push({ kind: "custom", entry });
      break;
    case "thinking_level_change":
    case "agent_change":
      break;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
  return { items, seq: entry.seq };
}

/** Project one branch, oldest first, into the conversation items a client renders. */
export function transcriptFromEntries(entries: readonly Entry[]): Turn[] {
  return [...entries.reduce(appendTranscriptEntry, EMPTY_TRANSCRIPT).items];
}
