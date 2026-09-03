import type { Entry, LogItem } from "../harness/session/types.ts";

export interface SessionDirectoryEntry {
  id: string;
  name?: string;
  preview?: string;
  lastActivity: number;
  heads: string[];
}

function messagePreview(entry: Entry): string | undefined {
  switch (entry.type) {
    case "message": {
      const { message } = entry;
      switch (message.role) {
        case "user": {
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => {
                    switch (part.type) {
                      case "text":
                        return part.text;
                      case "image":
                        return "";
                      default: {
                        const _exhaustive: never = part;
                        return _exhaustive;
                      }
                    }
                  })
                  .join("");
          const preview = text.trim();
          return preview === "" ? undefined : preview;
        }
        case "assistant": {
          const preview = message.content
            .map((part) => {
              switch (part.type) {
                case "text":
                  return part.text;
                case "thinking":
                case "toolCall":
                  return "";
                default: {
                  const _exhaustive: never = part;
                  return _exhaustive;
                }
              }
            })
            .join("")
            .trim();
          return preview === "" ? undefined : preview;
        }
        case "toolResult":
          return undefined;
        default: {
          const _exhaustive: never = message;
          return _exhaustive;
        }
      }
    }
    case "compaction":
    case "branch_summary":
    case "model_change":
    case "thinking_level_change":
    case "agent_change":
    case "custom":
      return undefined;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

/** Build the row shared by session pickers without opening storage from the view. */
export function sessionDirectoryEntryFromLog(input: {
  metadata: { readonly id: string; readonly createdAt: number };
  log: readonly LogItem[];
}): SessionDirectoryEntry {
  const heads = new Set<string>(["main"]);
  let name: { seq: number; value: string } | undefined;
  let preview: { seq: number; value: string } | undefined;
  let lastActivity = input.metadata.createdAt;

  for (const item of input.log) {
    switch (item.kind) {
      case "entry": {
        lastActivity = Math.max(lastActivity, item.entry.timestamp);
        const value = messagePreview(item.entry);
        if (value !== undefined && (preview === undefined || item.seq > preview.seq)) {
          preview = { seq: item.seq, value };
        }
        break;
      }
      case "record":
        lastActivity = Math.max(lastActivity, item.record.timestamp);
        break;
      case "head": {
        heads.add(item.head);
        break;
      }
      case "fact":
        if (name === undefined || item.seq > name.seq) name = { seq: item.seq, value: item.name };
        break;
      case "fact_value":
      case "claim":
        break;
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  }

  return {
    id: input.metadata.id,
    lastActivity,
    heads: [...heads].toSorted((left, right) => left.localeCompare(right)),
    ...(name === undefined ? {} : { name: name.value }),
    ...(preview === undefined ? {} : { preview: preview.value }),
  };
}
