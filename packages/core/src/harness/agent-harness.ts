/**
 * Durable AgentHarness host facade. Admission and reads go to the store;
 * execution composes the stateless runner in runner.ts.
 *
 * Per the locked core-to-harness rule this composition drives the standalone
 * loop; the loop knows nothing about it.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/agent-harness.ts
 * and https://github.com/earendil-works/pi/blob/dev/packages/coding-agent/src/core/agent-session.ts
 */
import { acquireSessionResources } from "@uji-ai/ai/session-resources";
import type { RetryPolicy } from "@uji-ai/ai/utils/retry";
import type { Api, Message, Model, Skill } from "@uji-ai/schema";
import type {
  AgentEvent,
  AgentTool,
  QueueMode,
  StreamFn,
  ThinkingLevel,
  ToolExecutionMode,
} from "../types.ts";
import { createRegistries, PluginHost, type HarnessRegistries } from "../plugins/host.ts";
import type {
  AskAnswer,
  AskRequest,
  Command,
  LoadedPlugin,
  PluginEnv,
  PluginInfo,
  PluginSetting,
} from "../plugins/types.ts";
import { formatSkillInvocation } from "../skills.ts";
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  type CompactionSettings,
} from "./compaction/compaction.ts";
import { DEFAULT_RETRY_POLICY, validateCompactionSettings, validateRetryPolicy } from "./config.ts";
import { type HookName, HookRegistry } from "./hooks.ts";
import { Result, TaggedError, type Result as ResultValue } from "./result.ts";
import {
  drive,
  resume as resumeRunner,
  type CompactionOutcome,
  type OperationError,
  type RunnerFinished,
  type RunnerOptions,
  type RunOutcome,
  type StepResult,
} from "./runner.ts";
import type { SendReceipt } from "./session/store.ts";
import { newId } from "./session/types.ts";
import type {
  CompactionEntry,
  Entry,
  MessageEntry,
  OperationFinishedRecord,
  ProvisionedEntry,
  QueueEnqueuedRecord,
  RunIntent,
  RunState,
  SessionStorage,
} from "./session/types.ts";
import type { AgentHarnessStreamOptions } from "./types.ts";

export type { CompactionOutcome, OperationError, RunOutcome } from "./runner.ts";

const HEAD = "main";
const REGISTRY_PROPERTIES = [
  "tools",
  "commands",
  "prompt",
  "resources",
  "settings",
] satisfies readonly (keyof HarnessRegistries)[];

const NoActiveRunBase = TaggedError("NoActiveRun");
export class NoActiveRun extends NoActiveRunBase<{ head: string; message: string }> {}
const NothingToResumeBase = TaggedError("NothingToResume");
export class NothingToResume extends NothingToResumeBase<{ head: string; message: string }> {}
const NothingToCompactBase = TaggedError("NothingToCompact");
export class NothingToCompact extends NothingToCompactBase<{ head: string; message: string }> {}
const ClosedBase = TaggedError("Closed");
export class Closed extends ClosedBase<{ message: string }> {}
const UnknownSkillBase = TaggedError("UnknownSkill");
export class UnknownSkill extends UnknownSkillBase<{ name: string; message: string }> {}
const NotQueuedBase = TaggedError("NotQueued");
export class NotQueued extends NotQueuedBase<{ entryId: string; message: string }> {}

export type RunResult = ResultValue<{ runId: string } & RunOutcome, Closed>;
export type SkillResult = ResultValue<{ runId: string } & RunOutcome, Closed | UnknownSkill>;
export type CompactionResult = ResultValue<
  { operation: "compaction"; runId: string } & CompactionOutcome,
  NothingToCompact | Closed
>;
export type QueueResult = ResultValue<{ entryId: string }, Closed>;
export type QueueCancelResult = ResultValue<{ entryId: string }, NotQueued | Closed>;
export type MessageDelivery = "steer" | "queue";
export interface PendingQueueItem {
  readonly entryId: string;
  readonly delivery: MessageDelivery | "nextRun";
  readonly message: Message;
}
export type SubmitResult = ResultValue<
  | { disposition: "started"; runId: string }
  | { disposition: "queued"; entryId: string; runId: string; delivery: MessageDelivery },
  Closed
>;
export type AbortResult = ResultValue<{ runId: string }, NoActiveRun | Closed>;
export type ResumeOutcome =
  | ({ operation: "run"; runId: string } & RunOutcome)
  | ({ operation: "compaction"; runId: string } & CompactionOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, NothingToResume | Closed>;

export type SuspendedOperation =
  | { head: string; id: string; startedAt: number; kind: "run"; prompt: Message[] }
  | {
      head: string;
      id: string;
      startedAt: number;
      kind: "compaction";
      customInstructions?: string;
    };

/** A loop tool plus its crash-replay policy (pi HarnessTool). */
export type HarnessTool = AgentTool;

export interface AgentHarnessOptions {
  session: SessionStorage;
  streamFn: StreamFn;
  /** Everything the harness exposes to the model comes from these. Built-ins are plugins too. */
  plugins: readonly LoadedPlugin[];
  env: PluginEnv;
  model: Model<Api>;
  /** How long an `ask` waits for a client before taking the request's default. */
  askTimeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
  retry?: RetryPolicy;
  compaction?: CompactionSettings;
  /** Provider request defaults applied before per-run options and request hooks. */
  streamOptions?: AgentHarnessStreamOptions;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
}

export interface HarnessState {
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isBusy: boolean;
  readonly streamingText?: string;
  readonly model: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly errorMessage?: string;
}

export type CompactionReason = "manual" | "threshold" | "overflow";
export type CompactionEvent =
  | { type: "compaction_start"; runId: string; reason: CompactionReason }
  | ({ type: "compaction_end"; runId: string; reason: CompactionReason } & (
      | { outcome: "completed"; entry: CompactionEntry; fromHook: boolean }
      | { outcome: "aborted" }
      | { outcome: "failed"; error: OperationError }
    ));
export type HandlerErrorEvent = { type: "handler_error"; error: string; stack?: string } & (
  | { kind: "hook"; hook: HookName }
  | { kind: "event"; event: string }
  | { kind: "plugin"; plugin: string }
);
export type HostEvent =
  | { type: "plugin_updated"; plugins: readonly PluginInfo[] }
  | { type: "config_update"; property: (typeof REGISTRY_PROPERTIES)[number] }
  | { type: "queue_update"; items: readonly PendingQueueItem[] }
  | { type: "diagnostic"; level: "warn" | "error"; owner: string; message: string }
  | { type: "ask"; askId: string; pluginId: string; request: AskRequest }
  | { type: "ask_answered"; askId: string; answer: AskAnswer; source: "client" | "default" };
type MessageOverlayEvent = Extract<AgentEvent, { type: "message_update" }> & { entryId: string };
type ToolOverlayEvent = Extract<
  AgentEvent,
  { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
> & { entryId: string };
export type HarnessEvent =
  | Exclude<
      AgentEvent,
      {
        type:
          | "agent_end"
          | "message_update"
          | "message_end"
          | "tool_execution_start"
          | "tool_execution_update"
          | "tool_execution_end";
      }
    >
  | { type: "agent_end" }
  | MessageOverlayEvent
  | ToolOverlayEvent
  | { type: "message_end"; message: AgentEventMessage; entryId: string }
  | CompactionEvent
  | HandlerErrorEvent
  | HostEvent;
type AgentEventMessage = Extract<AgentEvent, { type: "message_end" }>["message"];
export type HarnessListener = (event: HarnessEvent) => void | Promise<void>;

interface PendingAsk {
  answer(answer: AskAnswer, source: "client" | "default"): boolean;
  cancel(error: Error): void;
}

type Admission =
  | { kind: "started"; runId: string; completion: Promise<RunnerFinished> }
  | { kind: "joined"; runId: string; completion: Promise<RunnerFinished> }
  | {
      kind: "queued";
      runId: string;
      receipt: Extract<SendReceipt, { disposition: "queued" }>;
      completion: Promise<RunnerFinished>;
    };

interface ActivityProjection {
  read(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined): HarnessState;
  apply(event: HarnessEvent): void;
}

function isUserMessageEntry(entry: Entry): boolean {
  return entry.type === "message" && entry.message.role === "user";
}

function createActivityProjection(): ActivityProjection {
  let activity: "idle" | "streaming" | "compacting" = "idle";
  let streamingText: string | undefined;
  let errorMessage: string | undefined;
  return {
    read(model, thinkingLevel) {
      return {
        isStreaming: activity === "streaming",
        isCompacting: activity === "compacting",
        isBusy: activity !== "idle",
        streamingText,
        model,
        thinkingLevel,
        errorMessage,
      };
    },
    apply(event) {
      switch (event.type) {
        case "compaction_start":
          activity = "compacting";
          break;
        case "compaction_end":
          activity = "idle";
          if (event.outcome === "failed") errorMessage = event.error.message;
          break;
        case "agent_start":
          activity = "streaming";
          errorMessage = undefined;
          break;
        case "turn_start":
          streamingText = undefined;
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            streamingText = (streamingText ?? "") + event.assistantMessageEvent.delta;
          }
          break;
        case "turn_end":
          if (
            event.message.role === "assistant" &&
            event.message.stopReason !== "aborted" &&
            event.message.errorMessage !== undefined
          ) {
            errorMessage = event.message.errorMessage;
          }
          break;
        case "agent_end":
          activity = "idle";
          streamingText = undefined;
          break;
        case "ask":
        case "ask_answered":
        case "config_update":
        case "diagnostic":
        case "handler_error":
        case "message_end":
        case "message_start":
        case "plugin_updated":
        case "queue_update":
        case "tool_execution_end":
        case "tool_execution_start":
        case "tool_execution_update":
          break;
        default: {
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    },
  };
}

function matchesAskRequest<TRequest extends AskRequest>(
  request: TRequest,
  answer: AskAnswer,
): answer is AskAnswer<TRequest> {
  switch (request.kind) {
    case "confirm":
      return typeof answer === "boolean";
    case "select":
      return (
        typeof answer === "string" && request.options.some((option) => option.value === answer)
      );
    case "input":
      return typeof answer === "string";
    default: {
      const _exhaustive: never = request;
      return _exhaustive;
    }
  }
}

export class AgentHarness {
  readonly name = HEAD;
  readonly session: SessionStorage;
  readonly hooks: HookRegistry;
  readonly plugins: PluginHost;
  readonly env: PluginEnv;
  readonly registries: HarnessRegistries = createRegistries();

  private readonly options: AgentHarnessOptions;
  private readonly listeners = new Set<HarnessListener>();
  /** Slice 7 makes asks durable; until then only this compatibility path stays in memory. */
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private readonly activity = createActivityProjection();
  private readonly releaseSessionResources: () => void;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly attachments = new Set<AbortController>();

  private constructor(options: AgentHarnessOptions, releaseSessionResources: () => void) {
    validateRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
    validateCompactionSettings(options.compaction ?? DEFAULT_COMPACTION_SETTINGS);
    this.options = options;
    this.releaseSessionResources = releaseSessionResources;
    this.session = options.session;
    this.env = options.env;
    this.plugins = new PluginHost(this);
    this.hooks = new HookRegistry((error, hook) =>
      this.emit({
        type: "handler_error",
        kind: "hook",
        hook,
        error: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
      }),
    );
  }

  static async create(
    options: AgentHarnessOptions,
  ): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
    const sessionId = (await options.session.getMetadata()).id;
    const harness = new AgentHarness(options, acquireSessionResources(sessionId));
    try {
      await harness.plugins.activate(options.plugins);
      const open = await options.session.findOpenOperations(HEAD);
      const suspended = open.map((record): SuspendedOperation => {
        switch (record.intent.kind) {
          case "run":
            return {
              kind: "run",
              head: record.head,
              id: record.id,
              startedAt: record.timestamp,
              prompt: record.intent.originalPrompt,
            };
          case "compaction":
            return {
              kind: "compaction",
              head: record.head,
              id: record.id,
              startedAt: record.timestamp,
              ...(record.intent.customInstructions === undefined
                ? {}
                : { customInstructions: record.intent.customInstructions }),
            };
          default: {
            const _exhaustive: never = record.intent;
            return _exhaustive;
          }
        }
      });
      return { harness, suspended };
    } catch (error) {
      await harness.close().catch(() => undefined);
      throw error;
    }
  }

  reportPluginError(pluginId: string, error: Error): void {
    void this.emit({
      type: "handler_error",
      kind: "plugin",
      plugin: pluginId,
      error: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    });
  }

  subscribe(listener: HarnessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTools(): HarnessTool[] {
    return this.registries.tools.values();
  }

  getCommands(): ReadonlyMap<string, Command> {
    return this.registries.commands.current();
  }

  getResources(): ReadonlyMap<string, Skill> {
    return this.registries.resources.current();
  }

  getSettings(): ReadonlyMap<string, PluginSetting> {
    return this.registries.settings.current();
  }

  getSystemPrompt(): string {
    return this.registries.prompt
      .values()
      .map((section, index) => ({ section, index }))
      .sort(
        (left, right) =>
          (left.section.order ?? 100) - (right.section.order ?? 100) || left.index - right.index,
      )
      .map(({ section }) => section.text)
      .join("\n\n");
  }

  async runCommand(name: string, argument = ""): Promise<string | undefined> {
    const command = this.registries.commands.get(name);
    if (command === undefined) throw new Error(`unknown command: ${name}`);
    return (await command.run(argument)) ?? undefined;
  }

  rebuildAll(): void {
    for (const property of REGISTRY_PROPERTIES) {
      const diff = this.registries[property].rebuild();
      for (const failure of diff.errors) {
        void this.emit({
          type: "diagnostic",
          level: "error",
          owner: failure.owner,
          message: failure.message,
        });
      }
      if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
        void this.emit({ type: "config_update", property });
      }
    }
  }

  async ask<TRequest extends AskRequest>(
    pluginId: string,
    request: TRequest,
  ): Promise<AskAnswer<TRequest>> {
    if (this.closed) throw new Closed({ message: "harness is closed" });
    const askId = newId("a");
    const timeoutMs = this.options.askTimeoutMs ?? 120_000;
    const answered = new Promise<{
      answer: AskAnswer<TRequest>;
      source: "client" | "default";
    }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(askId);
        if (request.default === undefined) reject(new Error(`no answer to "${request.title}"`));
        else if (!matchesAskRequest(request, request.default)) {
          reject(new Error(`invalid default answer to "${request.title}"`));
        } else resolve({ answer: request.default, source: "default" });
      }, timeoutMs);
      timer.unref?.();
      this.pendingAsks.set(askId, {
        answer: (answer, source) => {
          if (!matchesAskRequest(request, answer)) return false;
          clearTimeout(timer);
          this.pendingAsks.delete(askId);
          resolve({ answer, source });
          return true;
        },
        cancel: (error) => {
          clearTimeout(timer);
          this.pendingAsks.delete(askId);
          reject(error);
        },
      });
    });
    void answered.catch(() => undefined);
    await this.emit({ type: "ask", askId, pluginId, request });
    const result = await answered;
    await this.emit({
      type: "ask_answered",
      askId,
      answer: result.answer,
      source: result.source,
    });
    return result.answer;
  }

  answer(askId: string, answer: AskAnswer): boolean {
    return this.pendingAsks.get(askId)?.answer(answer, "client") ?? false;
  }

  dismissAsk(askId: string): boolean {
    const pending = this.pendingAsks.get(askId);
    if (pending === undefined) return false;
    pending.cancel(new Error("ask dismissed by client"));
    return true;
  }

  setModel(model: Model<Api>): void {
    this.options.model = model;
  }

  setCompactionSettings(settings: CompactionSettings): void {
    validateCompactionSettings(settings);
    this.options.compaction = { ...settings };
  }

  setStreamOptions(options: AgentHarnessStreamOptions): void {
    this.options.streamOptions = {
      ...options,
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
      ...(options.samplingParams === undefined
        ? {}
        : { samplingParams: { ...options.samplingParams } }),
    };
  }

  get state(): HarnessState {
    return this.activity.read(this.options.model, this.options.thinkingLevel);
  }

  async waitForIdle(): Promise<RunResult | CompactionResult | void> {
    while (true) {
      const open = await this.session.findOpenOperations(HEAD);
      const operation = open[0];
      if (operation !== undefined) {
        const finished = await this.awaitFinished(operation.id);
        return this.facadeResult(finished);
      }
      const claim = await this.session.getLiveClaim(HEAD);
      if (claim === undefined) return;
      await this.waitForOperationStart(claim.runId);
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    for (const attachment of this.attachments) attachment.abort();
    this.cancelPendingAsks(new Closed({ message: "harness is closed" }));
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const errors: unknown[] = [];
    await this.abortOperation().catch((error: unknown) => errors.push(error));
    await this.waitForIdle().catch((error: unknown) => errors.push(error));
    await this.plugins.close().catch((error: unknown) => errors.push(error));
    try {
      this.hooks.close(new Closed({ message: "harness is closed" }));
    } catch (error) {
      errors.push(error);
    }
    try {
      this.releaseSessionResources();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close harness");
  }

  private cancelPendingAsks(error: Error): void {
    for (const pending of [...this.pendingAsks.values()]) pending.cancel(error);
  }

  async submit(
    input: string | Message,
    options: { delivery?: MessageDelivery } = {},
  ): Promise<SubmitResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const delivery = options.delivery ?? "steer";
    const admission = await this.admit([this.normalizeOne(input)], delivery);
    void admission.completion.catch((error: unknown) =>
      this.emit({
        type: "diagnostic",
        level: "error",
        owner: "runner",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    switch (admission.kind) {
      case "started":
      case "joined":
        return Result.ok({ disposition: "started", runId: admission.runId });
      case "queued":
        return Result.ok({
          disposition: "queued",
          entryId: admission.receipt.entryId,
          runId: admission.runId,
          delivery,
        });
      default: {
        const _exhaustive: never = admission;
        return _exhaustive;
      }
    }
  }

  /** Submit through multiplayer admission, then await the accepted run's completion. */
  async prompt(input: string | Message | Message[]): Promise<RunResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const admission = await this.admit(this.normalize(input), "steer");
    const finished = await admission.completion;
    if (finished.operation !== "run") {
      throw new Error(`Prompt joined non-run operation ${finished.runId}`);
    }
    return Result.ok({ runId: finished.runId, ...finished.outcome });
  }

  async skill(name: string, additionalInstructions?: string): Promise<SkillResult> {
    const skill = this.registries.resources.get(name);
    if (skill === undefined) {
      return Result.err(new UnknownSkill({ name, message: `unknown skill: ${name}` }));
    }
    return this.prompt(formatSkillInvocation(skill, additionalInstructions));
  }

  async steer(input: string | Message): Promise<QueueResult> {
    return this.sendParticipant(input, "steer");
  }

  async followUp(input: string | Message): Promise<QueueResult> {
    return this.sendParticipant(input, "queue");
  }

  async nextRun(input: string | Message): Promise<QueueResult> {
    return this.sendParticipant(input, "queue");
  }

  private async sendParticipant(
    input: string | Message,
    delivery: MessageDelivery,
  ): Promise<QueueResult> {
    const submitted = await this.submit(input, { delivery });
    if (!submitted.ok) return submitted;
    return Result.ok({
      entryId:
        submitted.value.disposition === "queued"
          ? submitted.value.entryId
          : ((await this.session.getLeafId(HEAD)) ?? submitted.value.runId),
    });
  }

  async pendingQueue(): Promise<readonly PendingQueueItem[]> {
    const records = await this.pendingQueueRecords();
    return records.map((record) => ({
      entryId: record.target.id,
      delivery:
        record.queue === "followUp" ? "queue" : record.queue === "steer" ? "steer" : "nextRun",
      message: record.target.message,
    }));
  }

  async cancelQueued(entryId: string): Promise<QueueCancelResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const pending = (await this.pendingQueueRecords()).some(
      (record) => record.target.id === entryId,
    );
    if (!pending) {
      return Result.err(new NotQueued({ entryId, message: "queue item is not pending" }));
    }
    await this.session.appendRecord({
      type: "queue_cancelled",
      id: newId("r"),
      head: HEAD,
      entryId,
    });
    await this.emitQueueUpdate();
    return Result.ok({ entryId });
  }

  async compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
    while (true) {
      if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
      const branch = await this.session.getBranch(HEAD);
      const preparation = prepareCompaction(
        branch,
        this.options.compaction ?? DEFAULT_COMPACTION_SETTINGS,
      );
      if (!preparation.ok) {
        return Result.err(new NothingToCompact({ head: HEAD, message: preparation.error.message }));
      }
      if (preparation.value === undefined) {
        return Result.err(
          new NothingToCompact({
            head: HEAD,
            message:
              branch.at(-1)?.type === "compaction"
                ? "conversation is already compacted"
                : "nothing to compact",
          }),
        );
      }

      const runId = newId("compact");
      const claimed = await this.session.claimRun(HEAD, runId);
      if (!claimed.ok) {
        await this.awaitFinished(claimed.holder.runId);
        continue;
      }
      try {
        await claimed.writer.appendRecord({
          type: "operation_started",
          id: runId,
          head: HEAD,
          sourceLeafId: await this.session.getLeafId(HEAD),
          intent: {
            kind: "compaction",
            ...(options?.customInstructions === undefined
              ? {}
              : { customInstructions: options.customInstructions }),
          },
        });
      } finally {
        await claimed.writer.release();
      }
      const finished = await this.startDrive(runId, "compaction");
      if (finished.operation !== "compaction") {
        throw new Error(`Compaction ${runId} finished as ${finished.operation}`);
      }
      return Result.ok({ operation: "compaction", runId, ...finished.outcome });
    }
  }

  async abort(options: { continue?: boolean } = {}): Promise<AbortResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const runId = await this.abortOperation(options);
    return runId === undefined
      ? Result.err(new NoActiveRun({ head: HEAD, message: "no active operation to abort" }))
      : Result.ok({ runId });
  }

  private async abortOperation(options: { continue?: boolean } = {}): Promise<string | undefined> {
    let operation = (await this.session.findOpenOperations(HEAD))[0];
    if (operation === undefined) {
      const claim = await this.session.getLiveClaim(HEAD);
      if (claim === undefined) return undefined;
      operation = await this.waitForOperationStart(claim.runId);
    }
    this.cancelPendingAsks(new Error("operation aborted"));
    try {
      await this.session.appendRecord({
        type: "abort_requested",
        id: newId("r"),
        head: HEAD,
        runId: operation.id,
        ...(options.continue === true ? { continueSteers: true } : {}),
      });
    } catch (error) {
      await this.session.requestAbort(HEAD);
      throw error;
    }
    return operation.id;
  }

  async resume(): Promise<ResumeResult> {
    if (this.closed) return Result.err(new Closed({ message: "harness is closed" }));
    const operation = (await this.session.findOpenOperations(HEAD))[0];
    if (operation === undefined) {
      return Result.err(new NothingToResume({ head: HEAD, message: "no suspended operation" }));
    }
    const isRun = operation.intent.kind === "run";
    if (isRun) await this.emit({ type: "agent_start" });
    const first = await resumeRunner(this.runnerOptions(operation.id));
    const stopped =
      first.kind === "continue" ? await drive(this.runnerOptions(operation.id)) : first;
    const finished = await this.toFacadeFinished(operation.id, stopped);
    if (isRun) await this.emit({ type: "agent_end" });
    await this.afterDrive(finished);
    return Result.ok(this.resumeOutcome(finished));
  }

  /**
   * Volunteer this process as a runner for the head (design record:
   * "Admission is open", who runs).
   * Whenever the head is idle with work pending, ensure a run: pick up an
   * orphaned open operation, start a run for a user message any process placed
   * after the last operation, or wake queued steers. Attached hosts race on the
   * claim CAS and losers do nothing, so attaching from several processes is safe.
   */
  attach(): () => void {
    const controller = new AbortController();
    this.attachments.add(controller);
    void this.attachLoop(controller.signal)
      .catch((error: unknown) => this.reportRunnerError(error))
      .finally(() => this.attachments.delete(controller));
    return () => controller.abort();
  }

  private async attachLoop(signal: AbortSignal): Promise<void> {
    let cursor = -1;
    let scannedTo = await this.ensureRun(cursor);
    cursor = scannedTo.cursor;
    for await (const item of this.session.watch({ afterSeq: cursor, signal })) {
      cursor = item.seq;
      if (this.closed) return;
      if (item.kind === "fact" || item.kind === "fact_value") continue;
      scannedTo = await this.ensureRun(scannedTo.afterOperation);
    }
  }

  /**
   * One idle-head check over the log since the last operation record. Returns
   * the seq to scan from next time so the check stays incremental.
   */
  private async ensureRun(afterSeq: number): Promise<{ cursor: number; afterOperation: number }> {
    const log = await this.session.getLog({ afterSeq });
    let cursor = afterSeq;
    let afterOperation = afterSeq;
    let placedSeq = -1;
    for (const item of log) {
      cursor = item.seq;
      if (item.kind === "entry" && item.head === HEAD && isUserMessageEntry(item.entry)) {
        placedSeq = item.seq;
      }
      if (
        item.kind === "record" &&
        (item.record.type === "operation_started" || item.record.type === "operation_finished")
      ) {
        afterOperation = item.seq;
      }
    }
    if (this.closed) return { cursor, afterOperation };
    if ((await this.session.getLiveClaim(HEAD)) !== undefined) return { cursor, afterOperation };
    const openOperation = (await this.session.findOpenOperations(HEAD))[0];
    if (openOperation !== undefined) {
      void this.resume().catch((error: unknown) => this.reportRunnerError(error));
    } else if (placedSeq > afterOperation) {
      const runId = await this.startRun({ kind: "run", originalPrompt: [], initialMessages: [] });
      if (runId !== undefined) {
        void this.startDrive(runId, "run").catch((error: unknown) => this.reportRunnerError(error));
      }
    } else {
      await this.wakePendingSteers();
    }
    return { cursor, afterOperation };
  }

  private reportRunnerError(error: unknown): Promise<void> {
    return this.emit({
      type: "diagnostic",
      level: "error",
      owner: "runner",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  async emit(event: HarnessEvent): Promise<void> {
    this.activity.apply(event);
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        if (event.type === "handler_error") continue;
        const normalized = error instanceof Error ? error : new Error(String(error));
        await this.emit({
          type: "handler_error",
          kind: "event",
          event: event.type,
          error: normalized.message,
          ...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
        });
      }
    }
  }

  private async admit(messages: readonly Message[], delivery: MessageDelivery): Promise<Admission> {
    const openOperation = (await this.session.findOpenOperations(HEAD))[0];
    const runId = openOperation?.id ?? newId("run");
    const claimed = await this.session.claimRun(HEAD, runId);
    if (!claimed.ok) {
      let queued: Extract<SendReceipt, { disposition: "queued" }> | undefined;
      const placed: Array<{
        message: Message;
        receipt: Extract<SendReceipt, { disposition: "placed" }>;
      }> = [];
      for (const message of messages) {
        const receipt = await this.session.send(message, { delivery });
        if (receipt.disposition === "queued") queued ??= receipt;
        else placed.push({ message, receipt });
      }
      for (const item of placed) {
        await this.emit({ type: "message_start", message: item.message });
        await this.emit({
          type: "message_end",
          message: item.message,
          entryId: item.receipt.entryId,
        });
      }
      if (queued !== undefined) {
        await this.emitQueueUpdate();
        return {
          kind: "queued",
          runId: queued.runId,
          receipt: queued,
          completion: this.awaitFinished(queued.runId),
        };
      }
      const retry = await this.session.claimRun(HEAD, runId);
      if (!retry.ok) {
        return {
          kind: "joined",
          runId: retry.holder.runId,
          completion: this.awaitFinished(retry.holder.runId),
        };
      }
      try {
        await retry.writer.appendRecord({
          type: "operation_started",
          id: runId,
          head: HEAD,
          sourceLeafId: await this.session.getLeafId(HEAD),
          intent: { kind: "run", originalPrompt: [...messages], initialMessages: [] },
        });
      } finally {
        await retry.writer.release();
      }
      return { kind: "started", runId, completion: this.startDrive(runId, "run") };
    }

    if (openOperation !== undefined) {
      let receipt: Extract<SendReceipt, { disposition: "queued" }> | undefined;
      try {
        for (const message of messages) {
          const admitted = await this.session.send(message, { delivery });
          if (admitted.disposition !== "queued" || admitted.runId !== runId) {
            throw new Error(`Admission escaped open run ${runId}`);
          }
          receipt ??= admitted;
        }
      } finally {
        await claimed.writer.release();
      }
      if (receipt === undefined) throw new Error(`Open run ${runId} received no input`);
      await this.emitQueueUpdate();
      void this.startDrive(runId, "run").catch((error: unknown) =>
        this.emit({
          type: "diagnostic",
          level: "error",
          owner: "runner",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return {
        kind: "queued",
        runId,
        receipt,
        completion: this.awaitFinished(runId),
      };
    }

    const initialMessages: ProvisionedEntry<MessageEntry>[] = [];
    try {
      for (const message of messages) {
        initialMessages.push({ type: "message", id: newId("e"), message });
      }
      await claimed.writer.appendRecord({
        type: "operation_started",
        id: runId,
        head: HEAD,
        sourceLeafId: await this.session.getLeafId(HEAD),
        intent: {
          kind: "run",
          originalPrompt: messages.map((message) => structuredClone(message)),
          initialMessages,
        },
      });
      for (const provisioned of initialMessages) {
        await claimed.writer.appendEntry(provisioned);
        await this.emit({ type: "message_start", message: provisioned.message });
        await this.emit({
          type: "message_end",
          message: provisioned.message,
          entryId: provisioned.id,
        });
      }
    } finally {
      await claimed.writer.release();
    }
    return { kind: "started", runId, completion: this.startDrive(runId, "run") };
  }

  private async startDrive(runId: string, kind: "run" | "compaction"): Promise<RunnerFinished> {
    if (kind === "run") await this.emit({ type: "agent_start" });
    const stopped = await drive(this.runnerOptions(runId));
    const finished = await this.toFacadeFinished(runId, stopped);
    if (kind === "run") await this.emit({ type: "agent_end" });
    await this.afterDrive(finished);
    return finished;
  }

  private async toFacadeFinished(
    runId: string,
    stopped: Exclude<StepResult, { kind: "continue" }>,
  ): Promise<RunnerFinished> {
    switch (stopped.kind) {
      case "finished":
        return stopped;
      case "claimed_elsewhere": {
        const state = await this.session.runState(runId);
        if (state.kind === "missing") throw new Error(`Run ${runId} disappeared`);
        const message =
          stopped.holder.runId === runId
            ? `Run ${runId} is already claimed by another runner`
            : `Head ${stopped.head} is claimed by ${stopped.holder.runId}`;
        const outcome = {
          kind: "failed",
          leafId: state.operation.sourceLeafId,
          error: { code: "claim_lost", message },
        } satisfies RunOutcome;
        switch (state.operation.intent.kind) {
          case "run":
            return { kind: "finished", operation: "run", runId, outcome };
          case "compaction":
            return { kind: "finished", operation: "compaction", runId, outcome };
          default: {
            const _exhaustive: never = state.operation.intent;
            return _exhaustive;
          }
        }
      }
      default: {
        const _exhaustive: never = stopped;
        return _exhaustive;
      }
    }
  }

  private async afterDrive(finished: RunnerFinished): Promise<void> {
    if (finished.operation !== "run" || this.closed) return;
    const state = await this.session.runState(finished.runId);
    const continueSteers =
      state.kind !== "missing" && state.abortRequested?.continueSteers === true;
    const wake = finished.outcome.kind !== "failed" || finished.outcome.error.code !== "claim_lost";
    if (wake && (finished.outcome.kind !== "aborted" || continueSteers)) {
      await this.wakePendingSteers();
    }
  }

  private async wakePendingSteers(): Promise<void> {
    if (this.closed || (await this.session.getLiveClaim(HEAD)) !== undefined) return;
    if (!(await this.pendingQueueRecords()).some((record) => record.queue === "steer")) return;
    const runId = await this.startRun({
      kind: "run",
      originalPrompt: [],
      initialMessages: [],
      promotionScope: "steer",
    });
    if (runId !== undefined) await this.startDrive(runId, "run");
  }

  /** Claim the head and record operation_started; undefined when another runner won the claim. */
  private async startRun(intent: RunIntent): Promise<string | undefined> {
    const runId = newId("run");
    const claimed = await this.session.claimRun(HEAD, runId);
    if (!claimed.ok) return undefined;
    try {
      await claimed.writer.appendRecord({
        type: "operation_started",
        id: runId,
        head: HEAD,
        sourceLeafId: await this.session.getLeafId(HEAD),
        intent,
      });
    } finally {
      await claimed.writer.release();
    }
    return runId;
  }

  private runnerOptions(runId: string): RunnerOptions {
    return {
      session: this.session,
      runId,
      hooks: this.hooks,
      streamFn: this.options.streamFn,
      tools: this.getTools(),
      model: this.options.model,
      systemPrompt: this.getSystemPrompt(),
      emit: (event) => this.emit(event),
      thinkingLevel: this.options.thinkingLevel,
      retry: this.options.retry,
      compaction: this.options.compaction,
      streamOptions: this.options.streamOptions,
      steeringMode: this.options.steeringMode,
      followUpMode: this.options.followUpMode,
      toolExecution: this.options.toolExecution,
    };
  }

  private async awaitFinished(runId: string): Promise<RunnerFinished> {
    const initial = await this.session.runState(runId);
    if (initial.kind === "finished") return this.finishedFromState(initial);
    for await (const item of this.session.watch()) {
      if (
        item.kind !== "record" ||
        item.record.type !== "operation_finished" ||
        item.record.runId !== runId
      ) {
        continue;
      }
      const state = await this.session.runState(runId);
      if (state.kind === "finished") return this.finishedFromState(state);
    }
    throw new Error(`Session closed before ${runId} finished`);
  }

  private async waitForOperationStart(runId: string): Promise<OperationStarted> {
    const existing = await this.session.runState(runId);
    if (existing.kind !== "missing") return existing.operation;
    for await (const item of this.session.watch()) {
      if (
        item.kind === "record" &&
        item.record.type === "operation_started" &&
        item.record.id === runId
      ) {
        return item.record;
      }
    }
    throw new Error(`Session closed before ${runId} started`);
  }

  private finishedFromState(state: Extract<RunState, { kind: "finished" }>): RunnerFinished {
    const leafId =
      state.finished.leafId ??
      (state.operation.intent.kind === "compaction" && state.compaction.kind === "compacted"
        ? state.compaction.entry.id
        : state.operation.sourceLeafId);
    const outcome = this.recordOutcome(state.finished, leafId);
    if (state.operation.intent.kind === "run") {
      return { kind: "finished", operation: "run", runId: state.operation.id, outcome };
    }
    if (outcome.kind === "completed" && state.compaction.kind === "compacted") {
      return {
        kind: "finished",
        operation: "compaction",
        runId: state.operation.id,
        outcome: {
          kind: "completed",
          leafId: state.compaction.entry.id,
          entry: state.compaction.entry,
        },
      };
    }
    if (outcome.kind === "completed") {
      return {
        kind: "finished",
        operation: "compaction",
        runId: state.operation.id,
        outcome: {
          kind: "failed",
          leafId,
          error: { code: "compaction", message: "compaction finished without a checkpoint" },
        },
      };
    }
    return { kind: "finished", operation: "compaction", runId: state.operation.id, outcome };
  }

  private recordOutcome(record: OperationFinishedRecord, leafId: string | null): RunOutcome {
    switch (record.outcome) {
      case "completed":
      case "aborted":
        return { kind: record.outcome, leafId };
      case "failed":
        return {
          kind: "failed",
          leafId,
          error: normalizeOperationError(record.error),
        };
      default: {
        const _exhaustive: never = record.outcome;
        return _exhaustive;
      }
    }
  }

  private facadeResult(finished: RunnerFinished): RunResult | CompactionResult {
    switch (finished.operation) {
      case "run":
        return Result.ok({ runId: finished.runId, ...finished.outcome });
      case "compaction":
        return Result.ok({
          operation: "compaction",
          runId: finished.runId,
          ...finished.outcome,
        });
      default: {
        const _exhaustive: never = finished;
        return _exhaustive;
      }
    }
  }

  private resumeOutcome(finished: RunnerFinished): ResumeOutcome {
    switch (finished.operation) {
      case "run":
        return { operation: "run", runId: finished.runId, ...finished.outcome };
      case "compaction":
        return { operation: "compaction", runId: finished.runId, ...finished.outcome };
      default: {
        const _exhaustive: never = finished;
        return _exhaustive;
      }
    }
  }

  private async pendingQueueRecords(): Promise<QueueEnqueuedRecord[]> {
    const latestByEntry = new Map<string, QueueEnqueuedRecord>();
    for (const record of await this.session.findRecords({ type: "queue_enqueued" })) {
      latestByEntry.set(record.target.id, record);
    }
    const cancelled = new Set(
      (await this.session.findRecords({ type: "queue_cancelled" })).map((record) => record.entryId),
    );
    const pending: QueueEnqueuedRecord[] = [];
    for (const record of latestByEntry.values()) {
      if (cancelled.has(record.target.id)) continue;
      if ((await this.session.getEntry(record.target.id)) !== undefined) continue;
      pending.push(record);
    }
    return pending;
  }

  private async emitQueueUpdate(): Promise<void> {
    await this.emit({ type: "queue_update", items: await this.pendingQueue() });
  }

  private normalize(input: string | Message | Message[]): Message[] {
    if (Array.isArray(input)) return input;
    return [this.normalizeOne(input)];
  }

  private normalizeOne(input: string | Message): Message {
    return typeof input === "string"
      ? { role: "user", content: input, timestamp: Date.now() }
      : input;
  }
}

type OperationStarted = Extract<
  Awaited<ReturnType<SessionStorage["findOpenOperations"]>>[number],
  { type: "operation_started" }
>;

function normalizeOperationError(error: OperationFinishedRecord["error"]): OperationError {
  if (error === undefined) return { code: "harness", message: "run failed" };
  switch (error.code) {
    case "claim_lost":
    case "compaction":
    case "harness":
    case "refused":
    case "stream":
    case "summarization_failed":
      return { code: error.code, message: error.message };
    default:
      return { code: "harness", message: error.message };
  }
}
