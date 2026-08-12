// Loop layer — standalone; knows nothing below this line (pi ch.1 rule).
export {
  runAgentLoop,
  runAgentLoopContinue,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentContext,
  type AgentEvent,
  type AgentEventSink,
  type AgentLoopConfig,
  type AgentLoopTurnUpdate,
  type AgentTool,
  type AgentToolCall,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type AssistantTurn,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type LlmContext,
  type QueueMode,
  type ShouldStopAfterTurnContext,
  type StopReason,
  type StreamDelta,
  type StreamFn,
  type StreamFnOptions,
  type ThinkingLevel,
  type ToolExecutionMode,
  type TurnUsage,
} from "./agent-loop.ts";

// The durable harness — the only composition over the loop.
export {
  AgentHarness,
  Closed,
  LaneBusy,
  NoActiveRun,
  NothingToResume,
  type AbortResult,
  type AgentHarnessOptions,
  type HarnessListener,
  type HarnessState,
  type HarnessTool,
  type OperationError,
  type QueueResult,
  type ResumeResult,
  type RunOutcome,
  type RunResult,
  type SuspendedOperation,
} from "./harness/agent-harness.ts";
export { Result, TaggedError } from "./harness/result.ts";
export { JsonlSessionRepo, JsonlSessionStorage, newId } from "./harness/session/jsonl.ts";
export * from "./harness/session/types.ts";

export { createProviderStreamFn, type ProviderStreamFnOptions } from "./stream-fn.ts";

// Coding tool set (pi port).
export * from "./tools/index.ts";
