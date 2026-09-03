/**
 * `@uji-ai/core/store`: the durable session store, for hosts and storage
 * backends. A client never imports this entry — it holds raw entries, records,
 * and claims, the shapes the SDK projects before anything renders them.
 */
export { SqliteSessionRepo, type SqliteSessionRepoOptions } from "./harness/session/sqlite.ts";
export type {
  ClaimOutcome,
  ClaimRunOutcome,
  DurableSessionStore,
  EntryAdmission,
  RunClaim,
  RunWriter,
  SendOptions,
  SendOrigin,
  SendReceipt,
  WatchOptions,
} from "./harness/session/store.ts";
export { newId, SessionError, toJsonValue } from "./harness/session/types.ts";
export type {
  AbortRequestedRecord,
  AgentChangeEntry,
  BranchSummaryEntry,
  CompactionEntry,
  CompactionIntent,
  CustomEntry,
  DeferredWriteRecord,
  Entry,
  LogItem,
  MessageEntry,
  ModelChangeEntry,
  NavigationIntent,
  NewRecord,
  OperationFinishedRecord,
  OperationStartedRecord,
  ParticipantRecord,
  ProvisionedEntry,
  QueueCancelledRecord,
  QueueConsumedRecord,
  QueueEnqueuedRecord,
  RetryScheduledRecord,
  RunConfig,
  RunIntent,
  RunRecord,
  RunState,
  SessionMetadata,
  SessionRecord,
  SessionRepo,
  SessionStorage,
  StepAttemptRecord,
  ThinkingLevelEntry,
  ToolReplyRecord,
  ToolStartedRecord,
  ToolWaitingRecord,
  ToolWakeObservedRecord,
  UsageRecord,
} from "./harness/session/types.ts";
export { drive, step } from "./harness/runner.ts";
export type { RunnerFinished, RunnerOptions, StepResult } from "./harness/runner.ts";

/**
 * Pure functions over entries, beside the store: what the log holds turned
 * into the messages a model is sent. A host that assembles its own prompt from
 * a branch (a title, a summary) folds it with these rather than re-deriving
 * which entries are context and which are markers.
 */
export {
  BRANCH_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  buildContextEntries,
  buildSessionContext,
  buildSessionModelContext,
  readSessionConfig,
} from "./harness/session/context.ts";
