/**
 * Branch summarization for tree navigation: what the branch being left was
 * about, kept as one entry at the destination so the context is not lost.
 *
 * Shares the model call, retry, serialization, and file tracking with
 * compaction but nothing else: its own path collection (the abandoned branch,
 * not the head's history), its own prompt, its own entry type, and no
 * checkpoint semantics.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts
 */
import type { RetryCallbacks, RetryPolicy } from "@uji-ai/ai/utils/retry";
import { contentText } from "@uji-ai/ai/utils/text";
import type { Api, Message, Model, Usage } from "@uji-ai/schema";
import type { StreamFn, ThinkingLevel } from "../../types.ts";
import { Result, type Result as ResultValue } from "../result.ts";
import { sessionEntryToContextMessages } from "../session/context.ts";
import type { BranchSummaryEntry, Entry } from "../session/types.ts";
import {
  CompactionError,
  completeSimpleWithRetries,
  estimateTokens,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./compaction.ts";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  serializeConversation,
} from "./utils.ts";

/** File-operation details stored on a branch summary entry. */
export interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export interface BranchSummaryPreparation {
  /** Messages of the abandoned branch, oldest first, cut to the token budget from the newest end. */
  messages: Message[];
  /** File operations from the whole branch, including nested branch summaries. */
  fileOps: FileOperations;
  totalTokens: number;
}

export interface BranchSummaryResult {
  summary: string;
  usage: Usage;
  details: BranchSummaryDetails;
}

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function readFileDetails(entry: BranchSummaryEntry, fileOps: FileOperations): void {
  const { details } = entry;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return;
  if (Array.isArray(details.readFiles)) {
    for (const path of details.readFiles) {
      if (typeof path === "string") fileOps.read.add(path);
    }
  }
  if (Array.isArray(details.modifiedFiles)) {
    for (const path of details.modifiedFiles) {
      if (typeof path === "string") fileOps.edited.add(path);
    }
  }
}

/** The messages one abandoned entry contributes to the summary prompt. */
function branchMessages(entry: Entry): Message[] {
  switch (entry.type) {
    case "message":
      // A tool result's substance is in the assistant's call; skip the bulk.
      return entry.message.role === "toolResult" ? [] : [entry.message];
    case "compaction":
    case "branch_summary":
      // Only the summary text: a compaction's retained tail is already on the path.
      return sessionEntryToContextMessages(entry).slice(0, 1);
    case "custom":
    case "model_change":
    case "thinking_level_change":
    case "agent_change":
      return [];
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

/**
 * Walk the abandoned branch from newest to oldest, adding messages until the
 * token budget is spent, so the most recent work survives when the branch is
 * long. File operations are collected from the whole branch regardless.
 */
export function prepareBranchSummary(
  entries: readonly Entry[],
  tokenBudget: number,
): BranchSummaryPreparation {
  const messages: Message[] = [];
  const fileOps = createFileOps();
  let totalTokens = 0;

  for (const entry of entries) {
    if (entry.type === "branch_summary") readFileDetails(entry, fileOps);
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const contributed = branchMessages(entry);
    if (contributed.length === 0) continue;
    for (const message of contributed) extractFileOpsFromMessage(message, fileOps);
    const tokens = contributed.reduce((sum, message) => sum + estimateTokens(message), 0);
    if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
      // A summary is dense context; squeeze it in unless the budget is nearly gone.
      const isSummary = entry.type === "compaction" || entry.type === "branch_summary";
      if (isSummary && totalTokens < tokenBudget * 0.9) {
        messages.unshift(...contributed);
        totalTokens += tokens;
      }
      break;
    }
    messages.unshift(...contributed);
    totalTokens += tokens;
  }

  return { messages, fileOps, totalTokens };
}

/** Summarize a prepared abandoned branch. Nothing here writes to the session. */
export async function generateBranchSummary(
  preparation: BranchSummaryPreparation,
  streamFn: StreamFn,
  model: Model<Api>,
  reserveTokens: number,
  customInstructions: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
): Promise<ResultValue<BranchSummaryResult, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const instructions =
    customInstructions === undefined || customInstructions === ""
      ? BRANCH_SUMMARY_PROMPT
      : `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
  const conversationText = serializeConversation(preparation.messages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;
  const summarizationMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() },
  ];
  const completionOptions =
    model.reasoning && thinkingLevel && thinkingLevel !== "off"
      ? { maxTokens, reasoning: thinkingLevel }
      : { maxTokens };

  const response = await completeSimpleWithRetries(
    streamFn,
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    completionOptions,
    retry,
    callbacks,
    signal,
  );
  if (response.stopReason === "aborted") {
    return Result.err(
      new CompactionError("aborted", response.errorMessage || "Branch summarization aborted"),
    );
  }
  if (response.stopReason === "error") {
    return Result.err(
      new CompactionError(
        "summarization_failed",
        `Branch summarization failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    return Result.err(
      new CompactionError("summarization_failed", "Branch summarization attempted to call a tool"),
    );
  }

  const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
  const text = contentText(response.content);
  const summary =
    BRANCH_SUMMARY_PREAMBLE +
    (text === "" ? "No summary generated" : text) +
    formatFileOperations(readFiles, modifiedFiles);
  return Result.ok({ summary, usage: response.usage, details: { readFiles, modifiedFiles } });
}
