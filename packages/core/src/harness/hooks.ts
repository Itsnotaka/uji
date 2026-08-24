/**
 * Hooks: the points where plugin code intercepts a run and returns a typed
 * result. This file holds the contract (which hooks exist, what each sees,
 * what each may return, how results combine) and the `HookRegistry` that runs
 * handlers in registration order, applies the combining rule, and contains
 * failures.
 *
 * Hooks are a separate list from events (`events.ts`). An event listener has
 * no return value the harness reads; a hook handler does. That split is what
 * keeps an observer from becoming an interceptor by accident.
 *
 * Combining rules, per hook:
 * - `before_run`: chained; each handler sees the prompt plus messages injected so far.
 * - `before_drive`: a throw refuses the drive (fail-closed).
 * - `before_run_end`: last writer wins for `followUp`. The harness loops for as
 *   long as a follow-up comes back; a handler is responsible for terminating
 *   (the event's `runId` and `messages` are enough to count or detect its own
 *   follow-ups). A handler that always returns one never lets the run end.
 * - `transform_context`: chained replacement of messages and system prompt.
 * - `before_request`: each patch applied in order over the stream options.
 * - `before_payload`, `after_response`: chained replacement.
 * - `before_tool`: args chained; the first `block` stops the chain; a throwing
 *   handler blocks the tool (fail-closed).
 * - `after_tool`: field-wise chained patch.
 * - `before_compaction`, `before_navigation`: not in `HookMap` yet; they land with
 *   compaction and navigation hooks, first structural answer wins.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/agent-harness.ts (HookMap)
 * Synced with pi 7ebf9087e.
 */
import type { AssistantMessage, JsonValue, Usage } from "@uji-ai/schema";
import type { AgentMessage, AgentToolResult } from "../types.ts";
import type { Context } from "./context.ts";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "./types.ts";
import type { AgentHarnessResources } from "./types.ts";

/**
 * The model a request is about. pi carries its full `Model<Api>` here; Uji's
 * provider layer identifies a model by provider id and model id, and the rest
 * of the description lives in `@uji-ai/ai`. Grows fields when a hook needs them.
 */
export interface HookModelRef {
  provider: string;
  modelId: string;
}

type VoidHookResult = ReturnType<() => void>;

export interface HookMap {
  before_run: {
    event: { prompt: AgentMessage[]; resources: AgentHarnessResources };
    result: { messages?: AgentMessage[] } | undefined;
  };
  before_drive: {
    event: { operation: "run" | "compaction" | "navigation" };
    result: VoidHookResult;
  };
  before_run_end: {
    event: { runId: string; messages: AgentMessage[] };
    result: { followUp?: string } | undefined;
  };
  transform_context: {
    event: { messages: AgentMessage[]; systemPrompt: string };
    result: { messages?: AgentMessage[]; systemPrompt?: string } | undefined;
  };
  before_request: {
    event: {
      model: HookModelRef;
      step: "assistant" | "deferred" | "compaction" | "branch_summary";
      attempt: number;
      streamOptions: AgentHarnessStreamOptions;
    };
    result: { streamOptions?: AgentHarnessStreamOptionsPatch } | undefined;
  };
  before_payload: {
    event: { model: HookModelRef; payload: unknown };
    result: { payload: unknown } | undefined;
  };
  after_response: {
    event: { status?: number; headers?: Record<string, string>; message: AssistantMessage };
    result: { message?: AssistantMessage } | undefined;
  };
  before_tool: {
    event: { toolCallId: string; toolName: string; args: Record<string, JsonValue> };
    result:
      | { args?: Record<string, JsonValue>; block?: { reason: string; terminate?: boolean } }
      | undefined;
  };
  after_tool: {
    event: {
      toolCallId: string;
      toolName: string;
      args: Record<string, JsonValue>;
      content: AgentToolResult<unknown>["content"];
      details?: JsonValue;
      isError: boolean;
      usage?: Usage;
    };
    result:
      | {
          content?: AgentToolResult<unknown>["content"];
          details?: JsonValue;
          isError?: boolean;
          usage?: Usage;
          terminate?: boolean;
        }
      | undefined;
  };
}

export type HookName = keyof HookMap;

/** Every hook event also says which head and run it belongs to. */
export type HookInvocation<TName extends HookName> = HookMap[TName]["event"] & {
  head: string;
  runId: string;
};

export type HookHandler<TName extends HookName> = (
  event: HookInvocation<TName>,
  context: Context,
) => Promise<HookMap[TName]["result"]> | HookMap[TName]["result"];

/** The registration half of the hook API, as a plugin sees it. */
export interface Hooks {
  on<TName extends HookName>(
    name: TName,
    handler: HookHandler<TName>,
    options?: { id?: string },
  ): () => void;
}

interface HookRegistration {
  id?: string;
  handler: (event: unknown, context: Context) => unknown;
}

/** Called with every handler failure before the combining rule decides what to do with it. */
export type HookErrorReporter = (
  error: Error,
  hook: HookName,
  head: string,
  context: Context,
) => void | Promise<void>;

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Ordered hook registry and aggregate runner. Two differences from pi's class.
 * pi admits each call through the effect gate first; Uji's gate lands with
 * `harness/execution`. pi opens its tool-handler span through a telemetry
 * module; Uji opens it on the `TelemetryContext` the `Context` carries.
 *
 * Handlers are stored with their event and result types erased, the same
 * way pi stores them, so each per-hook method narrows with a cast. The public
 * `on`/`run` signatures are the typed boundary.
 */
export class HookRegistry implements Hooks {
  private readonly registrations = new Map<HookName, HookRegistration[]>();
  private readonly reportError: HookErrorReporter;
  private closedError: Error | undefined;

  constructor(reportError: HookErrorReporter) {
    this.reportError = reportError;
  }

  on<TName extends HookName>(
    name: TName,
    handler: HookHandler<TName>,
    options: { id?: string } = {},
  ): () => void {
    if (this.closedError !== undefined) throw this.closedError;
    const registrations = this.registrations.get(name) ?? [];
    const registration: HookRegistration = {
      ...(options.id === undefined ? {} : { id: options.id }),
      handler: (event, context) => handler(event as HookInvocation<TName>, context),
    };
    registrations.push(registration);
    this.registrations.set(name, registrations);
    return () => {
      const index = registrations.indexOf(registration);
      if (index !== -1) registrations.splice(index, 1);
    };
  }

  has(name: HookName): boolean {
    return (this.registrations.get(name)?.length ?? 0) !== 0;
  }

  /** Run every handler registered for `name` and combine their results per the hook's rule. */
  async run<TName extends HookName>(
    name: TName,
    event: HookInvocation<TName>,
    context: Context,
  ): Promise<HookMap[TName]["result"]> {
    if (this.closedError !== undefined) throw this.closedError;
    return (await this.aggregate(name, event, context)) as HookMap[TName]["result"];
  }

  /** Refuse further registrations and runs, for a closed harness. */
  close(error: Error): void {
    this.closedError ??= error;
  }

  private aggregate(
    name: HookName,
    event: HookInvocation<HookName>,
    context: Context,
  ): Promise<unknown> {
    switch (name) {
      case "before_run":
        return this.beforeRun(event as HookInvocation<"before_run">, context);
      case "before_drive":
        return this.beforeDrive(event as HookInvocation<"before_drive">, context);
      case "before_run_end":
        return this.beforeRunEnd(event as HookInvocation<"before_run_end">, context);
      case "transform_context":
        return this.transformContext(event as HookInvocation<"transform_context">, context);
      case "before_request":
        return this.beforeRequest(event as HookInvocation<"before_request">, context);
      case "before_payload":
        return this.beforePayload(event as HookInvocation<"before_payload">, context);
      case "after_response":
        return this.afterResponse(event as HookInvocation<"after_response">, context);
      case "before_tool":
        return this.beforeTool(event as HookInvocation<"before_tool">, context);
      case "after_tool":
        return this.afterTool(event as HookInvocation<"after_tool">, context);
    }
  }

  private async beforeRun(
    event: HookInvocation<"before_run">,
    context: Context,
  ): Promise<HookMap["before_run"]["result"]> {
    let prompt = event.prompt;
    let injected: AgentMessage[] = [];
    for (const registration of this.registrationsFor("before_run")) {
      try {
        const result = (await registration.handler(
          { ...event, prompt },
          context,
        )) as HookMap["before_run"]["result"];
        if (result?.messages !== undefined) {
          injected = [...injected, ...result.messages];
          prompt = [...prompt, ...result.messages];
        }
      } catch (error) {
        await this.reportError(normalizeError(error), "before_run", event.head, context);
      }
    }
    return injected.length === 0 ? undefined : { messages: injected };
  }

  private async beforeDrive(
    event: HookInvocation<"before_drive">,
    context: Context,
  ): Promise<void> {
    for (const registration of this.registrationsFor("before_drive")) {
      try {
        await registration.handler(event, context);
      } catch (error) {
        const normalized = normalizeError(error);
        await this.reportError(normalized, "before_drive", event.head, context);
        throw normalized;
      }
    }
  }

  private async beforeRunEnd(
    event: HookInvocation<"before_run_end">,
    context: Context,
  ): Promise<HookMap["before_run_end"]["result"]> {
    let followUp: string | undefined;
    for (const registration of this.registrationsFor("before_run_end")) {
      try {
        const result = (await registration.handler(
          event,
          context,
        )) as HookMap["before_run_end"]["result"];
        if (result?.followUp !== undefined) followUp = result.followUp;
      } catch (error) {
        await this.reportError(normalizeError(error), "before_run_end", event.head, context);
      }
    }
    return followUp === undefined ? undefined : { followUp };
  }

  private async transformContext(
    event: HookInvocation<"transform_context">,
    context: Context,
  ): Promise<HookMap["transform_context"]["result"]> {
    let messages = event.messages;
    let systemPrompt = event.systemPrompt;
    for (const registration of this.registrationsFor("transform_context")) {
      try {
        const result = (await registration.handler(
          { ...event, messages, systemPrompt },
          context,
        )) as HookMap["transform_context"]["result"];
        if (result?.messages !== undefined) messages = result.messages;
        if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      } catch (error) {
        await this.reportError(normalizeError(error), "transform_context", event.head, context);
      }
    }
    return { messages, systemPrompt };
  }

  private async beforeRequest(
    event: HookInvocation<"before_request">,
    context: Context,
  ): Promise<HookMap["before_request"]["result"]> {
    let streamOptions = event.streamOptions;
    let changed = false;
    for (const registration of this.registrationsFor("before_request")) {
      try {
        const result = (await registration.handler(
          { ...event, streamOptions },
          context,
        )) as HookMap["before_request"]["result"];
        if (result?.streamOptions !== undefined) {
          streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
          changed = true;
        }
      } catch (error) {
        await this.reportError(normalizeError(error), "before_request", event.head, context);
      }
    }
    return changed
      ? { streamOptions: createStreamOptionsPatch(event.streamOptions, streamOptions) }
      : undefined;
  }

  private async beforePayload(
    event: HookInvocation<"before_payload">,
    context: Context,
  ): Promise<HookMap["before_payload"]["result"]> {
    let payload = event.payload;
    for (const registration of this.registrationsFor("before_payload")) {
      try {
        const result = (await registration.handler(
          { ...event, payload },
          context,
        )) as HookMap["before_payload"]["result"];
        if (result?.payload !== undefined) payload = result.payload;
      } catch (error) {
        await this.reportError(normalizeError(error), "before_payload", event.head, context);
      }
    }
    return { payload };
  }

  private async afterResponse(
    event: HookInvocation<"after_response">,
    context: Context,
  ): Promise<HookMap["after_response"]["result"]> {
    let message = event.message;
    for (const registration of this.registrationsFor("after_response")) {
      try {
        const result = (await registration.handler(
          { ...event, message },
          context,
        )) as HookMap["after_response"]["result"];
        if (result?.message !== undefined) message = result.message;
      } catch (error) {
        await this.reportError(normalizeError(error), "after_response", event.head, context);
      }
    }
    return { message };
  }

  private async beforeTool(
    event: HookInvocation<"before_tool">,
    context: Context,
  ): Promise<HookMap["before_tool"]["result"]> {
    let args = event.args;
    let block: { reason: string; terminate?: boolean } | undefined;
    for (const registration of this.registrationsFor("before_tool")) {
      try {
        const result = (await this.invokeToolRegistration(
          "before_tool",
          registration,
          { ...event, args },
          context,
        )) as HookMap["before_tool"]["result"];
        if (result?.args !== undefined) args = result.args;
        if (result?.block !== undefined) {
          block = result.block;
          break;
        }
      } catch (error) {
        const normalized = normalizeError(error);
        await this.reportError(normalized, "before_tool", event.head, context);
        block = { reason: normalized.message };
        break;
      }
    }
    return {
      ...(args === event.args ? {} : { args }),
      ...(block === undefined ? {} : { block }),
    };
  }

  private async afterTool(
    event: HookInvocation<"after_tool">,
    context: Context,
  ): Promise<HookMap["after_tool"]["result"]> {
    let current = {
      content: event.content,
      details: event.details,
      isError: event.isError,
      usage: event.usage,
    };
    const aggregate: NonNullable<HookMap["after_tool"]["result"]> = {};
    for (const registration of this.registrationsFor("after_tool")) {
      try {
        const result = (await this.invokeToolRegistration(
          "after_tool",
          registration,
          { ...event, ...current },
          context,
        )) as HookMap["after_tool"]["result"];
        if (result === undefined) continue;
        if (result.content !== undefined) aggregate.content = result.content;
        if (result.details !== undefined) aggregate.details = result.details;
        if (result.isError !== undefined) aggregate.isError = result.isError;
        if (result.usage !== undefined) aggregate.usage = result.usage;
        if (result.terminate !== undefined) aggregate.terminate = result.terminate;
        current = {
          content: result.content ?? current.content,
          details: result.details ?? current.details,
          isError: result.isError ?? current.isError,
          usage: result.usage ?? current.usage,
        };
      } catch (error) {
        await this.reportError(normalizeError(error), "after_tool", event.head, context);
      }
    }
    return Object.keys(aggregate).length === 0 ? undefined : aggregate;
  }

  private invokeToolRegistration(
    name: "before_tool" | "after_tool",
    registration: HookRegistration,
    event: HookInvocation<"before_tool"> | HookInvocation<"after_tool">,
    context: Context,
  ): Promise<unknown> {
    return context.telemetryContext.startSpan(
      {
        name: "uji.harness.hook",
        attributes: {
          "uji.head.name": event.head,
          "uji.operation.id": event.runId,
          "uji.hook.name": name,
          "uji.hook.registration_id": registration.id,
        },
      },
      async (span) => {
        try {
          const result = await registration.handler(event, context);
          const blocked =
            name === "before_tool" &&
            result !== null &&
            typeof result === "object" &&
            "block" in result &&
            result.block !== undefined;
          span.setAttributes({ "uji.hook.outcome": blocked ? "blocked" : "completed" });
          return result;
        } catch (error) {
          span.setAttributes({ "uji.hook.outcome": "failed" });
          throw error;
        }
      },
    );
  }

  private registrationsFor(name: HookName): HookRegistration[] {
    return [...(this.registrations.get(name) ?? [])];
  }
}

const SCALAR_STREAM_OPTION_KEYS = [
  "maxRetries",
  "maxRetryDelayMs",
  "transport",
  "cacheRetention",
  "fast",
  "temperature",
  "maxTokens",
] as const;

export function applyStreamOptionsPatch(
  base: AgentHarnessStreamOptions,
  patch: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
  const next: AgentHarnessStreamOptions = { ...base };
  for (const key of SCALAR_STREAM_OPTION_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete next[key];
    else Object.assign(next, { [key]: value });
  }
  if ("headers" in patch) {
    if (patch.headers === undefined) delete next.headers;
    else {
      const headers = { ...next.headers };
      for (const [key, value] of Object.entries(patch.headers)) {
        if (value === undefined) delete headers[key];
        else headers[key] = value;
      }
      next.headers = headers;
    }
  }
  if ("samplingParams" in patch) {
    if (patch.samplingParams === undefined) delete next.samplingParams;
    else {
      const samplingParams = { ...next.samplingParams };
      for (const [key, value] of Object.entries(patch.samplingParams)) {
        if (value === undefined) delete samplingParams[key];
        else samplingParams[key] = value;
      }
      next.samplingParams = samplingParams;
    }
  }
  return next;
}

function createStreamOptionsPatch(
  base: AgentHarnessStreamOptions,
  value: AgentHarnessStreamOptions,
): AgentHarnessStreamOptionsPatch {
  const patch: AgentHarnessStreamOptionsPatch = {};
  for (const key of SCALAR_STREAM_OPTION_KEYS) {
    if (base[key] !== value[key]) Object.assign(patch, { [key]: value[key] });
  }
  if (base.headers !== value.headers) {
    if (value.headers === undefined) patch.headers = undefined;
    else {
      const headers: Record<string, string | undefined> = {};
      for (const key of Object.keys(base.headers ?? {})) {
        if (!(key in value.headers)) headers[key] = undefined;
      }
      for (const [key, header] of Object.entries(value.headers)) {
        if (base.headers?.[key] !== header) headers[key] = header;
      }
      if (base.headers === undefined && Object.keys(headers).length === 0) patch.headers = {};
      else if (Object.keys(headers).length !== 0) patch.headers = headers;
    }
  }
  if (base.samplingParams !== value.samplingParams) {
    if (value.samplingParams === undefined) patch.samplingParams = undefined;
    else {
      const samplingParams: Record<string, unknown> = {};
      for (const key of Object.keys(base.samplingParams ?? {})) {
        if (!(key in value.samplingParams)) samplingParams[key] = undefined;
      }
      for (const [key, samplingParamsValue] of Object.entries(value.samplingParams)) {
        if (base.samplingParams?.[key] !== samplingParamsValue)
          samplingParams[key] = samplingParamsValue;
      }
      if (base.samplingParams === undefined && Object.keys(samplingParams).length === 0)
        patch.samplingParams = {};
      else if (Object.keys(samplingParams).length !== 0) patch.samplingParams = samplingParams;
    }
  }
  return patch;
}
