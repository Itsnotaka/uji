/**
 * Projects a durable session branch into model context. A compaction entry is
 * a checkpoint: entries before the newest checkpoint remain in the transcript
 * but are replaced in provider context by its summary and retained tail.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/session/context.ts
 * Synced with pi d4edf066f.
 */
import type { Message, UserMessage } from "@uji-ai/schema";
import type { CompactionEntry, Entry } from "./types.ts";

export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

export function createCompactionSummaryMessage(entry: CompactionEntry): UserMessage {
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
export function isContextMessage(message: Message): boolean {
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
    case "custom":
    case "model_change":
    case "thinking_level_change":
      return [];
  }
}

export function buildSessionContext(pathEntries: readonly Entry[]): Message[] {
  return buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages);
}
