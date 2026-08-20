/**
 * Durable AgentHarness, ported from pi-agent-core's new harness design and
 * scoped to June's current slice: one lane ("main"), run operations only.
 * The durability model is pi's: every run is bracketed by
 * operation_started/operation_finished records, assistant steps are declared
 * with step_attempt records, and every tool call commits an intent record
 * (tool_started, with a provisioned settlement entry id) before executing —
 * the effect sandwich. Crash recovery replays nothing that settled: unsettled
 * "safe" tools re-execute, unsettled "never" tools fail, and the run
 * continues from the durable branch.
 *
 * Per the locked core↛harness rule this composition drives the standalone
 * loop; the loop knows nothing about it.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/agent-harness.ts
 * and https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness.md
 */
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  Usage,
} from "@june/schema";
import { runAgentLoopContinue } from "../agent-loop.ts";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  QueueMode,
  StreamFn,
  ThinkingLevel,
  ToolExecutionMode,
} from "../types.ts";
import { toolResultContent } from "../utils/tool-result.ts";
import { Result, TaggedError, type Result as ResultValue } from "./result.ts";
import { newId, toJsonValue } from "./session/types.ts";
import type {
  MessageEntry,
  OperationStartedRecord,
  ProvisionedEntry,
  QueueEnqueuedRecord,
  SessionStorage,
} from "./session/types.ts";

const LANE = "main";

const LaneBusyBase = TaggedError("LaneBusy");
export class LaneBusy extends LaneBusyBase<{ lane: string; message: string }> {}
const NoActiveRunBase = TaggedError("NoActiveRun");
export class NoActiveRun extends NoActiveRunBase<{ lane: string; message: string }> {}
const NothingToResumeBase = TaggedError("NothingToResume");
export class NothingToResume extends NothingToResumeBase<{ lane: string; message: string }> {}
const ClosedBase = TaggedError("Closed");
export class Closed extends ClosedBase<{ message: string }> {}

export interface OperationError {
  code: string;
  message: string;
}

export type RunOutcome =
  | { kind: "completed" | "aborted"; leafId: string | null }
  | { kind: "failed"; leafId: string | null; error: OperationError };

export type RunResult = ResultValue<{ runId: string } & RunOutcome, LaneBusy | Closed>;
export type QueueResult = ResultValue<{ entryId: string }, NoActiveRun | Closed>;
export type AbortResult = ResultValue<{ runId: string }, NoActiveRun | Closed>;
export type ResumeResult = ResultValue<
  { runId: string } & RunOutcome,
  NothingToResume | LaneBusy | Closed
>;

export interface SuspendedOperation {
  lane: string;
  id: string;
  startedAt: number;
  prompt: Message[];
}

/** A loop tool plus its crash-replay policy (pi HarnessTool). */
export type HarnessTool = AgentTool<any, any> & { replay?: "never" | "safe" };

export interface AgentHarnessOptions {
  session: SessionStorage;
  streamFn: StreamFn;
  systemPrompt: string;
  tools?: HarnessTool[];
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
}

export interface HarnessState {
  readonly isStreaming: boolean;
  readonly streamingText?: string;
  readonly model: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly errorMessage?: string;
}

export type HarnessListener = (event: AgentEvent) => void | Promise<void>;

interface ActiveRun {
  runId: string;
  controller: AbortController;
  promise: Promise<RunResult>;
}

export class AgentHarness {
  readonly name = LANE;
  readonly session: SessionStorage;

  private readonly options: AgentHarnessOptions;
  private readonly listeners = new Set<HarnessListener>();
  private pendingPrompt?: Promise<RunResult>;
  private activeRun?: ActiveRun;
  private closed = false;
  private isStreaming = false;
  private streamingText: string | undefined;
  private errorMessage: string | undefined;

  private constructor(options: AgentHarnessOptions) {
    this.options = options;
    this.session = options.session;
  }

  /** Open the harness and report any operation left suspended by a crash. */
  static async create(
    options: AgentHarnessOptions,
  ): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
    const harness = new AgentHarness(options);
    const open = await options.session.findOpenOperations(LANE);
    const suspended = open.map((record) => ({
      lane: record.lane,
      id: record.id,
      startedAt: record.timestamp,
      prompt: record.intent.originalPrompt,
    }));
    return { harness, suspended };
  }

  subscribe(listener: HarnessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): HarnessState {
    return {
      isStreaming: this.isStreaming,
      streamingText: this.streamingText,
      model: this.options.model,
      thinkingLevel: this.options.thinkingLevel,
      errorMessage: this.errorMessage,
    };
  }

  waitForIdle(): Promise<RunResult | void> {
    return this.activeRun?.promise ?? this.pendingPrompt ?? Promise.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.waitForIdle();
  }

  /** Start a run: durably record intent + prompt entries, then drive the loop. */
  prompt(input: string | Message | Message[]): Promise<RunResult> {
    if (this.closed) {
      return Promise.resolve(Result.err(new Closed({ message: "harness is closed" })));
    }
    if (this.activeRun !== undefined || this.pendingPrompt !== undefined) {
      return Promise.resolve(
        Result.err(
          new LaneBusy({ lane: LANE, message: "a run is already active — steer() or followUp()" }),
        ),
      );
    }

    const prompt = this.normalize(input);
    const pending = this.acceptPrompt(prompt);
    this.pendingPrompt = pending;
    const clearPending = () => {
      if (this.pendingPrompt === pending) this.pendingPrompt = undefined;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  private async acceptPrompt(prompt: Message[]): Promise<RunResult> {
    const nextRun = await this.drainQueue("nextRun", undefined, "all");
    const initialMessages: ProvisionedEntry<MessageEntry>[] = [
      ...nextRun.map((item) => item.target),
      ...prompt.map((message) => ({ type: "message" as const, id: newId("e"), message })),
    ];
    const op = await this.session.appendRecord({
      type: "operation_started",
      id: newId("run"),
      lane: LANE,
      sourceLeafId: await this.session.getLeafId(LANE),
      intent: { kind: "run", originalPrompt: prompt, initialMessages },
    });
    for (const provisioned of initialMessages) {
      await this.session.appendEntry(provisioned, LANE);
      await this.emit({ type: "message_start", message: provisioned.message });
      await this.emit({ type: "message_end", message: provisioned.message });
    }
    this.pendingPrompt = undefined;
    return this.startRun(op.id, (controller) => this.executeRun(op.id, controller));
  }

  /** Queue a message after the current turn (requires an active run). */
  async steer(input: string | Message): Promise<QueueResult> {
    return this.enqueue("steer", input, true);
  }

  /** Queue a message for after the agent would otherwise stop (requires an active run). */
  async followUp(input: string | Message): Promise<QueueResult> {
    return this.enqueue("followUp", input, true);
  }

  /** Queue a message for the start of the next run (always allowed). */
  async nextRun(input: string | Message): Promise<QueueResult> {
    return this.enqueue("nextRun", input, false);
  }

  async abort(): Promise<AbortResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const run = this.activeRun;
    if (run === undefined) {
      return Result.err(new NoActiveRun({ lane: LANE, message: "no active run to abort" }));
    }
    await this.session.appendRecord({
      type: "abort_requested",
      id: newId("r"),
      lane: LANE,
      runId: run.runId,
    });
    run.controller.abort();
    return Result.ok({ runId: run.runId });
  }

  /**
   * Resume a crashed/suspended run: settle unsettled tool intents by replay
   * policy, then continue the loop from the durable branch.
   */
  async resume(): Promise<ResumeResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    if (this.activeRun !== undefined || this.pendingPrompt !== undefined) {
      return Result.err(new LaneBusy({ lane: LANE, message: "a run is already active" }));
    }
    const open = await this.session.findOpenOperations(LANE);
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    if (this.activeRun !== undefined || this.pendingPrompt !== undefined) {
      return Result.err(new LaneBusy({ lane: LANE, message: "a run is already active" }));
    }
    const op = open[0];
    if (op === undefined) {
      return Result.err(new NothingToResume({ lane: LANE, message: "no suspended operation" }));
    }
    return this.startRun(op.id, (controller) => this.resumeOperation(op, controller));
  }

  private async resumeOperation(
    op: OperationStartedRecord,
    controller: AbortController,
  ): Promise<RunResult> {
    // Prompt entries that never got appended (crash between record and append).
    for (const provisioned of op.intent.initialMessages) {
      if ((await this.session.getEntry(provisioned.id)) === undefined) {
        await this.session.appendEntry(provisioned, LANE);
      }
    }

    // Effect sandwich settlement: tool intents without their settlement entry.
    const toolIntents = await this.session.findRecords({ type: "tool_started", runId: op.id });
    for (const intent of toolIntents) {
      if ((await this.session.getEntry(intent.resultEntryId)) !== undefined) continue;
      const tool = this.options.tools?.find((t) => t.name === intent.toolName);
      let output: (TextContent | ImageContent)[];
      let usage: Usage | undefined;
      let isError: boolean;
      if (intent.replay === "safe" && tool !== undefined) {
        try {
          const result = await tool.execute(
            intent.toolCallId,
            intent.effectiveArgs,
            controller.signal,
          );
          output = result.content;
          usage = result.usage;
          isError = false;
        } catch (error) {
          output = toolResultContent(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          isError = true;
        }
      } else {
        output = toolResultContent(
          `Error: tool call "${intent.toolName}" was interrupted before completing and was not ` +
            "replayed. Re-issue it if the work is still needed.",
        );
        isError = true;
      }
      if (usage !== undefined) {
        await this.session.appendRecord({
          type: "usage",
          id: newId("r"),
          lane: LANE,
          runId: op.id,
          cause: "tool",
          usage,
        });
      }
      await this.session.appendEntry(
        {
          type: "message",
          id: intent.resultEntryId,
          message: {
            role: "toolResult",
            toolCallId: intent.toolCallId,
            toolName: intent.toolName,
            content: output,
            isError,
            timestamp: Date.now(),
          },
        },
        LANE,
      );
    }

    const branch = await this.session.getBranch(LANE);
    const last = branch[branch.length - 1];
    const lastMessage = last?.type === "message" ? last.message : undefined;
    const continuable =
      lastMessage !== undefined &&
      (lastMessage.role === "user" || lastMessage.role === "toolResult");
    if (!continuable) {
      const leafId = await this.session.getLeafId(LANE);
      const outcome: RunOutcome = { kind: "completed", leafId };
      await this.finishRun(op.id, outcome);
      return Result.ok({ runId: op.id, ...outcome });
    }
    return this.executeRun(op.id, controller);
  }

  private normalize(input: string | Message | Message[]): Message[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];
    return [{ role: "user", content: input, timestamp: Date.now() }];
  }

  private async enqueue(
    queue: QueueEnqueuedRecord["queue"],
    input: string | Message,
    requiresRun: boolean,
  ): Promise<QueueResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const runId = this.activeRun?.runId;
    if (requiresRun && runId === undefined) {
      return Result.err(
        new NoActiveRun({ lane: LANE, message: `${queue} requires an active run — use nextRun()` }),
      );
    }
    const message: Message =
      typeof input === "string" ? { role: "user", content: input, timestamp: Date.now() } : input;
    const target: ProvisionedEntry<MessageEntry> = { type: "message", id: newId("e"), message };
    await this.session.appendRecord({
      type: "queue_enqueued",
      id: newId("r"),
      lane: LANE,
      queue,
      ...(requiresRun && runId !== undefined && { runId }),
      target,
    });
    return Result.ok({ entryId: target.id });
  }

  /** Unconsumed queue items: enqueued, not cancelled, settlement entry not yet appended. */
  private async drainQueue(
    queue: QueueEnqueuedRecord["queue"],
    runId: string | undefined,
    mode: QueueMode,
  ): Promise<QueueEnqueuedRecord[]> {
    const enqueued = await this.session.findRecords({ type: "queue_enqueued" });
    const cancelled = new Set(
      (await this.session.findRecords({ type: "queue_cancelled" })).map((r) => r.entryId),
    );
    const pending: QueueEnqueuedRecord[] = [];
    for (const record of enqueued) {
      if (record.queue !== queue) continue;
      if (runId !== undefined && record.runId !== runId) continue;
      if (cancelled.has(record.target.id)) continue;
      if ((await this.session.getEntry(record.target.id)) !== undefined) continue;
      pending.push(record);
    }
    return mode === "all" ? pending : pending.slice(0, 1);
  }

  private async emit(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        this.errorMessage = undefined;
        break;
      case "turn_start":
        this.streamingText = undefined;
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.streamingText = (this.streamingText ?? "") + event.assistantMessageEvent.delta;
        }
        break;
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage !== undefined)
          this.errorMessage = event.message.errorMessage;
        break;
      case "agent_end":
        this.isStreaming = false;
        this.streamingText = undefined;
        break;
    }
    for (const listener of this.listeners) {
      await listener(event);
    }
  }

  private startRun(
    runId: string,
    operation: (controller: AbortController) => Promise<RunResult>,
  ): Promise<RunResult> {
    const controller = new AbortController();
    const promise = operation(controller).finally(() => {
      if (this.activeRun?.promise === promise) this.activeRun = undefined;
      this.isStreaming = false;
      this.streamingText = undefined;
    });
    this.activeRun = { runId, controller, promise };
    return promise;
  }

  private async executeRun(runId: string, controller: AbortController): Promise<RunResult> {
    const pendingProvisioned = new Map<AgentMessage, string>();
    const toolResultIds = new Map<string, string>();
    let attempt = 0;
    let lastTurn: AssistantMessage | undefined;

    const drainInto = async (queue: "steer" | "followUp", mode: QueueMode): Promise<Message[]> => {
      const records = await this.drainQueue(queue, runId, mode);
      return records.map((record) => {
        const target = record.target;
        pendingProvisioned.set(target.message, target.id);
        return target.message;
      });
    };

    try {
      const branch = await this.session.getBranch(LANE);
      const messages = branch
        .filter((entry): entry is MessageEntry => entry.type === "message")
        .map((entry) => entry.message);

      await runAgentLoopContinue(
        {
          systemPrompt: this.options.systemPrompt,
          messages,
          tools: this.options.tools,
        },
        {
          model: this.options.model,
          convertToLlm: (candidateMessages) =>
            candidateMessages.filter((message): message is Message => isProviderMessage(message)),
          reasoning: this.options.thinkingLevel === "off" ? undefined : this.options.thinkingLevel,
          toolExecution: this.options.toolExecution,
          getSteeringMessages: () =>
            drainInto("steer", this.options.steeringMode ?? "one-at-a-time"),
          getFollowUpMessages: () =>
            drainInto("followUp", this.options.followUpMode ?? "one-at-a-time"),
          beforeToolCall: async ({ toolCall, args }) => {
            const tool = this.options.tools?.find((t) => t.name === toolCall.name);
            const resultEntryId = newId("e");
            toolResultIds.set(toolCall.id, resultEntryId);
            await this.session.appendRecord({
              type: "tool_started",
              id: newId("r"),
              lane: LANE,
              runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              effectiveArgs: toJsonValue(args),
              resultEntryId,
              replay: tool?.replay ?? "never",
            });
            return undefined;
          },
        },
        async (event) => {
          if (event.type === "turn_start") {
            attempt += 1;
            await this.session.appendRecord({
              type: "step_attempt",
              id: newId("r"),
              lane: LANE,
              runId,
              step: "assistant",
              attempt,
            });
          } else if (event.type === "turn_end") {
            if (event.message.role !== "assistant") {
              throw new Error("turn_end must carry an assistant message");
            }
            lastTurn = event.message;
            await this.session.appendRecord({
              type: "usage",
              id: newId("r"),
              lane: LANE,
              runId,
              cause: "assistant",
              usage: event.message.usage,
            });
          } else if (event.type === "tool_execution_end" && event.result.usage !== undefined) {
            await this.session.appendRecord({
              type: "usage",
              id: newId("r"),
              lane: LANE,
              runId,
              cause: "tool",
              usage: event.result.usage,
            });
          } else if (event.type === "message_end") {
            const provisionedId = pendingProvisioned.get(event.message);
            pendingProvisioned.delete(event.message);
            const id =
              provisionedId ??
              (event.message.role === "toolResult"
                ? toolResultIds.get(event.message.toolCallId)
                : undefined) ??
              newId("e");
            await this.session.appendEntry({ type: "message", id, message: event.message }, LANE);
          }
          await this.emit(event);
        },
        controller.signal,
        this.options.streamFn,
      );

      const leafId = await this.session.getLeafId(LANE);
      let outcome: RunOutcome;
      if (lastTurn?.stopReason === "aborted") {
        outcome = { kind: "aborted", leafId };
      } else if (lastTurn?.stopReason === "error") {
        outcome = {
          kind: "failed",
          leafId,
          error: { code: "stream", message: lastTurn.errorMessage ?? "run failed" },
        };
      } else {
        outcome = { kind: "completed", leafId };
      }
      await this.finishRun(runId, outcome);
      return Result.ok({ runId, ...outcome });
    } catch (error) {
      const leafId = await this.session.getLeafId(LANE);
      const outcome: RunOutcome = {
        kind: "failed",
        leafId,
        error: {
          code: "harness",
          message: error instanceof Error ? error.message : String(error),
        },
      };
      await this.finishRun(runId, outcome);
      return Result.ok({ runId, ...outcome });
    }
  }

  private async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    await this.session.appendRecord({
      type: "operation_finished",
      id: newId("r"),
      lane: LANE,
      runId,
      outcome: outcome.kind,
      ...(outcome.kind === "failed" && { error: outcome.error }),
    });
  }
}

function isProviderMessage(message: AgentMessage): message is Message {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}
