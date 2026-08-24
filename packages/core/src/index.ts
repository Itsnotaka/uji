export {
  agentLoop,
  agentLoopContinue,
  runAgentLoop,
  runAgentLoopContinue,
  type AgentEventSink,
} from "./agent-loop.ts";
export * from "./types.ts";
export { EventStream } from "@uji-ai/ai";
export { toolResultContent, toolResultText } from "./utils/tool-result.ts";

export {
  AgentHarness,
  Closed,
  NoActiveRun,
  NotQueued,
  NothingToCompact,
  NothingToResume,
  UnknownSkill,
  type AbortResult,
  type AgentHarnessOptions,
  type CompactionEvent,
  type CompactionOutcome,
  type CompactionReason,
  type CompactionResult,
  type HandlerErrorEvent,
  type HarnessEvent,
  type HarnessListener,
  type HostEvent,
  type HarnessState,
  type HarnessTool,
  type MessageDelivery,
  type OperationError,
  type PendingQueueItem,
  type QueueCancelResult,
  type QueueResult,
  type ResumeOutcome,
  type ResumeResult,
  type RunOutcome,
  type RunResult,
  type SkillResult,
  type SubmitResult,
  type SuspendedOperation,
} from "./harness/agent-harness.ts";
export {
  drive,
  resume as resumeRun,
  step,
  type RunnerFinished,
  type RunnerOptions,
  type StepResult,
} from "./harness/runner.ts";
export * from "./skills.ts";
export * from "./harness/compaction/compaction.ts";
export { Result, TaggedError } from "./harness/result.ts";
export {
  BACKGROUND_CONTEXT,
  type Context,
  type ContextKey,
  createContextKey,
  withAbortSignal,
  withCancel,
  withContextValue,
  withoutAbortSignal,
  withTelemetryContext,
} from "./harness/context.ts";
export {
  applyStreamOptionsPatch,
  type HookErrorReporter,
  type HookHandler,
  type HookInvocation,
  type HookMap,
  type HookModelRef,
  type HookName,
  HookRegistry,
  type Hooks,
} from "./harness/hooks.ts";
export type * from "./harness/types.ts";
export * from "./plugins/index.ts";
export {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  buildContextEntries,
  buildSessionContext,
  createCompactionSummaryMessage,
  isContextMessage,
  sessionEntryToContextMessages,
} from "./harness/session/context.ts";
export { SqliteSessionRepo, type SqliteSessionRepoOptions } from "./harness/session/sqlite.ts";
export * from "./harness/session/types.ts";
export * from "./views/index.ts";

export {
  type TrustedWorkspace,
  WorkspaceTrustRequired,
  type WorkspaceTrustResolution,
  WorkspaceTrustStore,
} from "./workspace-trust.ts";

export * from "./tools/index.ts";
