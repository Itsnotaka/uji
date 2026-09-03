/**
 * Projects a durable session branch into model context. A compaction entry is
 * a checkpoint: entries before the newest checkpoint remain in the transcript
 * but are replaced in provider context by its summary and retained tail.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/session/context.ts
 * Synced with pi d4edf066f.
 */
import type {
  Api,
  Message,
  ProviderCheckpointMaterial,
  ProviderId,
  UserMessage,
} from "@uji-ai/schema";
import type { BranchSummaryEntry, CompactionEntry, Entry, RunConfig } from "./types.ts";

export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

function createCompactionSummaryMessage(entry: CompactionEntry): UserMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: COMPACTION_SUMMARY_PREFIX + entry.summary + COMPACTION_SUMMARY_SUFFIX,
      },
    ],
    timestamp: entry.timestamp,
  };
}

export const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "\n</summary>";

/** A branch summary joins context as one user message; nothing before it is dropped. */
export function createBranchSummaryMessage(entry: BranchSummaryEntry): UserMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX,
      },
    ],
    timestamp: entry.timestamp,
  };
}

/** Return the newest checkpoint and everything physically appended after it. */
export function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    const entry = pathEntries[index];
    if (entry?.type === "compaction") {
      return [entry, ...pathEntries.slice(index + 1)];
    }
  }
  return [...pathEntries];
}

/** Provider failures stay visible in the transcript but must not poison later requests. */
function isContextMessage(message: Message): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

export function sessionEntryToContextMessages(entry: Entry): Message[] {
  switch (entry.type) {
    case "message":
      return isContextMessage(entry.message) ? [entry.message] : [];
    case "compaction":
      return [
        createCompactionSummaryMessage(entry),
        ...entry.retainedTail.filter(isContextMessage),
      ];
    case "branch_summary":
      return entry.summary === "" ? [] : [createBranchSummaryMessage(entry)];
    case "custom":
    case "model_change":
    case "thinking_level_change":
    case "agent_change":
      return [];
  }
}

/**
 * Providers reject a tool result without its call in the adjacent assistant
 * message, and a call with no result. Real trees hold both shapes (aborts,
 * branch moves), so the projection drops orphaned results and settles
 * unanswered calls with synthetic aborted results.
 */
function enforceToolPairs(messages: readonly Message[]): Message[] {
  const output: Message[] = [];
  let open = new Map<string, { name: string; timestamp: number }>();
  const settleOpen = (): void => {
    for (const [toolCallId, call] of open) {
      output.push({
        role: "toolResult",
        toolCallId,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: `Error: tool call "${call.name}" was interrupted before completing and was not replayed.`,
          },
        ],
        details: {},
        isError: true,
        timestamp: call.timestamp,
      });
    }
    open = new Map();
  };
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (!open.delete(message.toolCallId)) continue;
      output.push(message);
      continue;
    }
    settleOpen();
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") {
          open.set(part.id, { name: part.name, timestamp: message.timestamp });
        }
      }
    }
    output.push(message);
  }
  settleOpen();
  return output;
}

export function buildSessionContext(pathEntries: readonly Entry[]): Message[] {
  return enforceToolPairs(buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages));
}

export interface SessionModelContext {
  readonly messages: Message[];
  readonly checkpoint?: ProviderCheckpointMaterial;
}

/** Use native checkpoint data only for the exact target that produced it. */
export function buildSessionModelContext(
  pathEntries: readonly Entry[],
  target: { provider: ProviderId; api: Api; model: string },
): SessionModelContext {
  const entries = buildContextEntries(pathEntries);
  const first = entries[0];
  if (
    first?.type === "compaction" &&
    first.material?.provider === target.provider &&
    first.material.api === target.api &&
    first.material.model === target.model
  ) {
    return {
      checkpoint: first.material,
      messages: enforceToolPairs(entries.slice(1).flatMap(sessionEntryToContextMessages)),
    };
  }
  return { messages: enforceToolPairs(entries.flatMap(sessionEntryToContextMessages)) };
}

/**
 * The run inputs the branch currently declares: the latest `model_change` and
 * `thinking_level_change` entries win. Folded over the whole branch, not the
 * post-compaction slice, because configuration survives a context checkpoint.
 */
export function readSessionConfig(pathEntries: readonly Entry[]): RunConfig {
  const config: RunConfig = {};
  for (const entry of pathEntries) {
    if (entry.type === "model_change") {
      config.model =
        entry.provider === undefined
          ? { id: entry.modelId }
          : { provider: entry.provider, id: entry.modelId };
    } else if (entry.type === "thinking_level_change") {
      config.thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "agent_change") {
      config.agent = entry.agentId;
    }
  }
  return config;
}
