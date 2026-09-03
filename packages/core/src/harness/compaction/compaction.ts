/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/compaction/compaction.ts
 * Synced with pi d4edf066f.
 */
import type { Context as AiContext, SimpleStreamOptions } from "@uji-ai/ai/types";
import { retryAssistantCall, type RetryCallbacks, type RetryPolicy } from "@uji-ai/ai/utils/retry";
import { contentText } from "@uji-ai/ai/utils/text";
import { uuidv7 } from "@uji-ai/ai/utils/uuid";
import type { Api, AssistantMessage, Message, Model, Usage } from "@uji-ai/schema";
import type { StreamFn, ThinkingLevel } from "../../types.ts";
import { Result, type Result as ResultValue } from "../result.ts";
import {
  buildContextEntries,
  createBranchSummaryMessage,
  sessionEntryToContextMessages,
} from "../session/context.ts";
import type { Entry } from "../session/types.ts";
import { addUsage } from "../utils/usage.ts";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  serializeConversation,
} from "./utils.ts";

type CompactionErrorCode = "aborted" | "summarization_failed";

export class CompactionError extends Error {
  readonly code: CompactionErrorCode;

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}

function ok<TValue>(value: TValue): { ok: true; value: TValue } {
  return Result.ok(value);
}

function err<TError>(error: TError): { ok: false; error: TError } {
  return Result.err(error);
}

/** File-operation details stored on generated compaction entries. */
interface CompactionDetails {
  /** Files read in the compacted history. */
  readFiles: string[];
  /** Files modified in the compacted history. */
  modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function extractFileOperations(
  messages: Message[],
  entries: Entry[],
  prevCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex];
    if (
      prevCompaction?.type === "compaction" &&
      typeof prevCompaction.details === "object" &&
      prevCompaction.details !== null &&
      !Array.isArray(prevCompaction.details)
    ) {
      if (Array.isArray(prevCompaction.details.readFiles)) {
        for (const path of prevCompaction.details.readFiles) {
          if (typeof path === "string") fileOps.read.add(path);
        }
      }
      if (Array.isArray(prevCompaction.details.modifiedFiles)) {
        for (const path of prevCompaction.details.modifiedFiles) {
          if (typeof path === "string") fileOps.edited.add(path);
        }
      }
    }
  }
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return fileOps;
}
function getMessageFromEntry(entry: Entry): Message | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  return undefined;
}

function getMessageFromEntryForCompaction(entry: Entry): Message | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  // A branch summary is history worth folding into the checkpoint.
  if (entry.type === "branch_summary") {
    return entry.summary === "" ? undefined : createBranchSummaryMessage(entry);
  }
  return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
interface CompactResult<T = unknown> {
  /** Summary text that replaces compacted history in future context. */
  summary: string;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Usage from the LLM call(s) that generated this summary, if available. */
  usage?: Usage;
  /** Retained recent messages stored directly on the compaction entry. */
  retainedTail: Message[];
  /** Optional implementation-specific details stored with the compaction entry. */
  details?: T;
}

export async function completeSimpleWithRetries(
  streamFn: StreamFn,
  model: Model<Api>,
  aiContext: AiContext,
  options: SimpleStreamOptions,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  // Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
  const requestOptions: SimpleStreamOptions = {
    ...options,
    signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
  };
  return retryAssistantCall(
    async () => (await streamFn(model, aiContext, requestOptions)).result(),
    retry,
    requestOptions.signal,
    callbacks,
  );
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: Message): Usage | undefined {
  if (msg.role === "assistant") {
    if (
      msg.stopReason !== "aborted" &&
      msg.stopReason !== "error" &&
      calculateContextTokens(msg.usage) > 0
    ) {
      return msg.usage;
    }
  }
  return undefined;
}

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: readonly Entry[]): Usage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) return usage;
    }
  }
  return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number;
  /** Estimated tokens after the most recent assistant usage block. */
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(
  messages: Message[],
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { usage, index: i };
  }
  return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: Message[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(
  content: string | Array<{ type: string; text?: string }>,
): number {
  if (typeof content === "string") {
    return content.length;
  }

  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) {
      chars += block.text.length;
    } else if (block.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: Message): number {
  let chars = 0;

  switch (message.role) {
    case "user": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      for (const block of message.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + safeJsonStringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult": {
      chars = estimateTextAndImageContentChars(message.content);
      return Math.ceil(chars / 4);
    }
  }
}
function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    switch (entry.type) {
      case "message": {
        const role = entry.message.role;
        switch (role) {
          case "user":
          case "assistant":
            cutPoints.push(i);
            break;
          case "toolResult":
            break;
        }
        break;
      }
      case "compaction":
      case "branch_summary":
      case "custom":
      case "model_change":
      case "thinking_level_change":
        break;
    }
  }
  return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user") {
        return i;
      }
    }
  }
  return -1;
}

/** Cut point selected for compaction. */
interface CutPointResult {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
function findCutPoint(
  entries: Entry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important signal, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
  currentMessages: Message[],
  streamFn: StreamFn,
  model: Model<Api>,
  reserveTokens: number,
  customInstructions: string | undefined,
  previousSummary: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
): Promise<ResultValue<{ text: string; usage: Usage }, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }
  const llmMessages = currentMessages;
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const summarizationMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now(),
    },
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
    return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `Summarization failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }

  const textContent = contentText(response.content);

  return ok({ text: textContent, usage: response.usage });
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Messages summarized into the history summary. */
  messagesToSummarize: Message[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: Message[];
  /** Recent messages retained after compaction and stored on the compaction entry. */
  retainedTail: Message[];
  /** Whether compaction splits a turn. */
  isSplitTurn: boolean;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  /** File operations extracted from summarized history. */
  fileOps: FileOperations;
  /** Settings used to prepare compaction. */
  settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
  pathEntries: Entry[],
  settings: CompactionSettings,
): ResultValue<CompactionPreparation | undefined, CompactionError> {
  if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
    return ok(undefined);
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let compactableEntries = pathEntries;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex];
    if (prevCompaction?.type === "compaction") {
      previousSummary = prevCompaction.summary;
      const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
        type: "message",
        id: `${prevCompaction.id}:retained:${index}`,
        parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
        seq: prevCompaction.seq,
        timestamp: message.timestamp,
        message,
      }));
      compactableEntries = [
        ...virtualRetainedEntries,
        ...pathEntries.slice(prevCompactionIndex + 1),
      ];
    }
  }
  const boundaryEnd = compactableEntries.length;

  const tokensBefore = estimateContextTokens(
    buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages),
  ).tokens;

  const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize: Message[] = [];
  for (let i = 0; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
    if (msg) messagesToSummarize.push(msg);
  }
  const turnPrefixMessages: Message[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
      if (msg) turnPrefixMessages.push(msg);
    }
  }
  const retainedTail: Message[] = [];
  for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
    const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
    if (msg) retainedTail.push(msg);
  }
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return ok({
    messagesToSummarize,
    turnPrefixMessages,
    retainedTail,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  });
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export async function compact(
  preparation: CompactionPreparation,
  streamFn: StreamFn,
  model: Model<Api>,
  customInstructions: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
): Promise<ResultValue<CompactResult, CompactionError>> {
  const {
    messagesToSummarize,
    turnPrefixMessages,
    retainedTail,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  } = preparation;

  let summary: string;
  let summaryUsage: Usage;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    let historyText = "No prior history.";
    let historyUsage: Usage | undefined;
    if (messagesToSummarize.length > 0) {
      const historyResult = await generateSummaryWithUsage(
        messagesToSummarize,
        streamFn,
        model,
        settings.reserveTokens,
        customInstructions,
        previousSummary,
        thinkingLevel,
        retry,
        callbacks,
        signal,
      );
      if (!historyResult.ok) return err(historyResult.error);
      historyText = historyResult.value.text;
      historyUsage = historyResult.value.usage;
    }
    const turnPrefixResult = await generateTurnPrefixSummary(
      turnPrefixMessages,
      streamFn,
      model,
      settings.reserveTokens,
      thinkingLevel,
      retry,
      callbacks,
      signal,
    );
    if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
    summaryUsage = historyUsage
      ? addUsage(historyUsage, turnPrefixResult.value.usage)
      : turnPrefixResult.value.usage;
  } else {
    const summaryResult = await generateSummaryWithUsage(
      messagesToSummarize,
      streamFn,
      model,
      settings.reserveTokens,
      customInstructions,
      previousSummary,
      thinkingLevel,
      retry,
      callbacks,
      signal,
    );
    if (!summaryResult.ok) return err(summaryResult.error);
    summary = summaryResult.value.text;
    summaryUsage = summaryResult.value.usage;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return ok({
    summary,
    tokensBefore,
    usage: summaryUsage,
    retainedTail,
    details: { readFiles, modifiedFiles } satisfies CompactionDetails,
  });
}
async function generateTurnPrefixSummary(
  messages: Message[],
  streamFn: StreamFn,
  model: Model<Api>,
  reserveTokens: number,
  thinkingLevel: ThinkingLevel | undefined,
  retry: RetryPolicy | undefined,
  callbacks: RetryCallbacks | undefined,
  signal: AbortSignal | undefined,
): Promise<ResultValue<{ text: string; usage: Usage }, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.5 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const llmMessages = messages;
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: promptText }],
      timestamp: Date.now(),
    },
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
    return err(
      new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"),
    );
  }
  if (response.stopReason === "error") {
    return err(
      new CompactionError(
        "summarization_failed",
        `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
      ),
    );
  }

  return ok({
    text: contentText(response.content),
    usage: response.usage,
  });
}
