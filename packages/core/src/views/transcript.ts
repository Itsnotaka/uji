import type { Entry } from "../harness/session/types.ts";

type MessageEntry = Extract<Entry, { type: "message" }>;
type UserMessage = Extract<MessageEntry["message"], { role: "user" }>;
type CompactionEntry = Extract<Entry, { type: "compaction" }>;
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
  args: unknown;
  result?: {
    output: string;
    details?: unknown;
    isError: boolean;
  };
};

export type TurnPart =
  | UserTurnPart
  | { kind: "assistant"; entryId: string; text: string }
  | { kind: "thinking"; text: string }
  | ToolTurnPart
  | { kind: "note"; text: string };

export type TurnOutcome = "completed" | "aborted" | "failed";

export type Turn =
  | {
      kind: "turn";
      id: string;
      parts: TurnPart[];
      outcome: TurnOutcome;
    }
  | { kind: "compaction"; entry: CompactionEntry }
  | { kind: "model_change"; entry: ModelChangeEntry }
  | { kind: "custom"; entry: CustomEntry };

type ConversationTurn = Extract<Turn, { kind: "turn" }>;

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
 * Project one branch, oldest first, into durable conversation turns. The newest
 * compaction is the first visible item because entries before it are no longer
 * part of the model's active context.
 */
export function transcriptFromEntries(entries: readonly Entry[]): Turn[] {
  const turns: Turn[] = [];
  const tools = new Map<string, ToolTurnPart>();
  let turn: ConversationTurn | undefined;
  let start = 0;

  for (const [index, entry] of entries.entries()) {
    if (entry.type === "compaction") start = index;
  }

  const ensureTurn = (id: string): ConversationTurn => {
    if (turn !== undefined) return turn;
    turn = { kind: "turn", id, parts: [], outcome: "completed" };
    turns.push(turn);
    return turn;
  };

  for (const entry of entries.slice(start)) {
    switch (entry.type) {
      case "compaction":
        turns.push({ kind: "compaction", entry });
        turn = undefined;
        tools.clear();
        break;
      case "model_change":
        turns.push({ kind: "model_change", entry });
        turn = undefined;
        tools.clear();
        break;
      case "thinking_level_change":
        break;
      case "custom":
        turns.push({ kind: "custom", entry });
        turn = undefined;
        tools.clear();
        break;
      case "message": {
        const { message } = entry;
        switch (message.role) {
          case "user":
            turn = {
              kind: "turn",
              id: entry.id,
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
            turns.push(turn);
            tools.clear();
            break;
          case "assistant": {
            const outcome = outcomeFrom(entry);
            if (!hasVisibleAssistantContent(entry) && outcome === "completed") break;
            const owner = ensureTurn(entry.id);
            owner.outcome = outcome;
            for (const part of message.content) {
              switch (part.type) {
                case "text":
                  if (part.text.trim() !== "") {
                    owner.parts.push({ kind: "assistant", entryId: entry.id, text: part.text });
                  }
                  break;
                case "thinking":
                  if (part.thinking.trim() !== "") {
                    owner.parts.push({ kind: "thinking", text: part.thinking });
                  }
                  break;
                case "toolCall": {
                  const tool: ToolTurnPart = {
                    kind: "tool",
                    callId: part.id,
                    toolName: part.name,
                    args: part.arguments,
                  };
                  tools.set(part.id, tool);
                  owner.parts.push(tool);
                  break;
                }
                default: {
                  const _exhaustive: never = part;
                  return _exhaustive;
                }
              }
            }
            if (message.stopReason !== "aborted" && message.errorMessage !== undefined) {
              owner.parts.push({ kind: "note", text: `Error: ${message.errorMessage}` });
            }
            break;
          }
          case "toolResult": {
            const owner = ensureTurn(entry.id);
            const result = {
              output: toolResultText(entry),
              isError: message.isError,
              ...(message.details === undefined ? {} : { details: message.details }),
            };
            const tool = tools.get(message.toolCallId);
            if (tool === undefined) {
              owner.parts.push({
                kind: "tool",
                callId: message.toolCallId,
                toolName: message.toolName,
                args: undefined,
                result,
              });
            } else {
              tool.result = result;
            }
            break;
          }
          default: {
            const _exhaustive: never = message;
            return _exhaustive;
          }
        }
        break;
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  }

  return turns;
}
