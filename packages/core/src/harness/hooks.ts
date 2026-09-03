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
 * - `transform_context`: chained replacement of messages and system prompt.
 * - `before_request`: each patch applied in order over the stream options.
 * - `before_tool`: policies run in registration order; `modify` decisions
 *   chain and `continue` is not terminal, so no decision bypasses a later
 *   policy. The first `reject` or `error` stops the chain. A throwing handler
 *   becomes `error` (fail-closed).
 * - `after_tool`: field-wise chained patch.
 * - `before_compaction`: first provider checkpoint wins; handler failures are
 *   contained and portable compaction still runs.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/agent-harness.ts (HookMap)
 * Synced with pi 7ebf9087e.
 */
import type {
  Context as ModelContext,
  JsonValue,
  ProviderCheckpointMaterial,
  Usage,
} from "@uji-ai/schema";
import type { AgentMessage, AgentToolResult } from "../types.ts";
import { toJsonValue } from "./session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "./types.ts";

/**
 * The model a request is about. pi carries its full `Model<Api>` here; Uji's
 * provider layer identifies a model by provider id and model id, and the rest
 * of the description lives in `@uji-ai/ai`. Grows fields when a hook needs them.
 */
export interface HookModelRef {
  provider: string;
  modelId: string;
}

export interface HookMap {
  transform_context: {
    event: { messages: AgentMessage[]; systemPrompt: string };
    result: { messages?: AgentMessage[]; systemPrompt?: string } | undefined;
  };
  before_compaction: {
    event: {
      model: HookModelRef;
      context: ModelContext;
      reason: "manual" | "threshold" | "overflow";
      customInstructions?: string;
      tokensBefore: number;
    };
    result: { material: ProviderCheckpointMaterial } | undefined;
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
  before_tool: {
    event: ToolCallRequest;
    result: ToolCallDecision;
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
        }
      | undefined;
  };
}

export type HookName = keyof HookMap;

/**
 * The model's proposed tool call at the last typed boundary before its
 * effect. `args` is read-only input: a policy that wants different arguments
 * returns `modify`, so the change is a decision later policies see.
 */
export interface ToolCallRequest {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, JsonValue>>;
}

/**
 * One policy handler's decision. `continue` has no objection and `modify`
 * passes new arguments to later handlers; neither ends the chain. `reject` is
 * a policy objection: the call never runs, the model sees `message` as the
 * tool's error result, and the run goes on. `error` is a policy-system
 * failure: the call settles the same way, then the runner fails the run with
 * a `policy` operation error, because a policy that cannot decide must not be
 * mistaken for one that allowed the call.
 */
export type ToolCallDecision =
  | { readonly action: "continue" }
  | { readonly action: "modify"; readonly args: Record<string, JsonValue> }
  | { readonly action: "reject"; readonly message: string }
  | { readonly action: "error"; readonly message: string };

/**
 * The runtime half of the decision contract. Registrations are stored with
 * their types erased, so an untyped handler can hand back anything; a value
 * that is not a decision must fail closed rather than pass as `continue`.
 * `modify.args` is checked separately (`durableArgs`): they become the
 * `tool_started` intent, so they must already be durable JSON here.
 */
function isToolCallDecision(value: unknown): value is ToolCallDecision {
  if (typeof value !== "object" || value === null || !("action" in value)) return false;
  switch (value.action) {
    case "continue":
      return true;
    case "modify":
      return "args" in value;
    case "reject":
    case "error":
      return "message" in value && typeof value.message === "string";
    default:
      return false;
  }
}

/**
 * Normalize a `modify` decision's arguments to the durable JSON object the
 * intent record stores, under the same strict contract the log applies, so a
 * Date, a function, `Infinity`, or a cycle fails here as a policy error and
 * never reaches the `tool_started` write as an ordinary tool error.
 */
function durableArgs(value: unknown, policy: string): Record<string, JsonValue> {
  let json: JsonValue;
  try {
    json = toJsonValue(value);
  } catch (error) {
    throw new Error(`${policy} modify args are not durable JSON: ${normalizeError(error).message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${policy} modify args must be a JSON object, received ${describeJson(json)}`);
  }
  return json;
}

function describeJson(value: JsonValue): string {
  return Array.isArray(value) ? "an array" : value === null ? "null" : typeof value;
}

/** Every hook event also says which head and run it belongs to. */
export type HookInvocation<TName extends HookName> = HookMap[TName]["event"] & {
  head: string;
  runId: string;
};

export type HookHandler<TName extends HookName> = (
  event: HookInvocation<TName>,
  signal?: AbortSignal,
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
  handler: (event: unknown, signal?: AbortSignal) => unknown;
}

/** Called with every handler failure before the combining rule decides what to do with it. */
export type HookErrorReporter = (
  error: Error,
  hook: HookName,
  head: string,
) => void | Promise<void>;

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function describeDecision(value: unknown): string {
  if (value === undefined) return "undefined (return an explicit decision)";
  if (typeof value !== "object" || value === null) return typeof value;
  return "action" in value ? `action ${JSON.stringify(value.action)}` : "no action field";
}

/**
 * Ordered hook registry and aggregate runner. One difference from pi's class:
 * pi admits each call through the effect gate first; Uji has no gate.
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
      handler: (event, signal) => handler(event as HookInvocation<TName>, signal),
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
    signal?: AbortSignal,
  ): Promise<HookMap[TName]["result"]> {
    if (this.closedError !== undefined) throw this.closedError;
    return (await this.aggregate(name, event, signal)) as HookMap[TName]["result"];
  }

  /** Refuse further registrations and runs, for a closed harness. */
  close(error: Error): void {
    this.closedError ??= error;
  }

  private aggregate(
    name: HookName,
    event: HookInvocation<HookName>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    switch (name) {
      case "transform_context":
        return this.transformContext(event as HookInvocation<"transform_context">, signal);
      case "before_compaction":
        return this.beforeCompaction(event as HookInvocation<"before_compaction">, signal);
      case "before_request":
        return this.beforeRequest(event as HookInvocation<"before_request">, signal);
      case "before_tool":
        return this.beforeTool(event as HookInvocation<"before_tool">, signal);
      case "after_tool":
        return this.afterTool(event as HookInvocation<"after_tool">, signal);
    }
  }

  private async transformContext(
    event: HookInvocation<"transform_context">,
    signal: AbortSignal | undefined,
  ): Promise<HookMap["transform_context"]["result"]> {
    let messages = event.messages;
    let systemPrompt = event.systemPrompt;
    for (const registration of this.registrationsFor("transform_context")) {
      try {
        const result = (await registration.handler(
          { ...event, messages, systemPrompt },
          signal,
        )) as HookMap["transform_context"]["result"];
        if (result?.messages !== undefined) messages = result.messages;
        if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      } catch (error) {
        await this.reportError(normalizeError(error), "transform_context", event.head);
      }
    }
    return { messages, systemPrompt };
  }

  private async beforeCompaction(
    event: HookInvocation<"before_compaction">,
    signal: AbortSignal | undefined,
  ): Promise<HookMap["before_compaction"]["result"]> {
    for (const registration of this.registrationsFor("before_compaction")) {
      try {
        const result = (await registration.handler(
          event,
          signal,
        )) as HookMap["before_compaction"]["result"];
        if (result !== undefined) return result;
      } catch (error) {
        await this.reportError(normalizeError(error), "before_compaction", event.head);
      }
    }
    return undefined;
  }

  private async beforeRequest(
    event: HookInvocation<"before_request">,
    signal: AbortSignal | undefined,
  ): Promise<HookMap["before_request"]["result"]> {
    let streamOptions = event.streamOptions;
    let changed = false;
    for (const registration of this.registrationsFor("before_request")) {
      try {
        const result = (await registration.handler(
          { ...event, streamOptions },
          signal,
        )) as HookMap["before_request"]["result"];
        if (result?.streamOptions !== undefined) {
          streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
          changed = true;
        }
      } catch (error) {
        await this.reportError(normalizeError(error), "before_request", event.head);
      }
    }
    return changed
      ? { streamOptions: createStreamOptionsPatch(event.streamOptions, streamOptions) }
      : undefined;
  }

  private async beforeTool(
    event: HookInvocation<"before_tool">,
    signal: AbortSignal | undefined,
  ): Promise<ToolCallDecision> {
    let modified: Record<string, JsonValue> | undefined;
    for (const registration of this.registrationsFor("before_tool")) {
      const policy = `before_tool policy${registration.id === undefined ? "" : ` ${registration.id}`}`;
      try {
        const result = await registration.handler(
          { ...event, args: modified ?? event.args },
          signal,
        );
        if (!isToolCallDecision(result)) {
          throw new Error(
            `${policy} returned a malformed decision for ${event.toolName}: ${describeDecision(result)}`,
          );
        }
        switch (result.action) {
          case "continue":
            break;
          case "modify":
            modified = durableArgs(result.args, policy);
            break;
          case "reject":
          case "error":
            return result;
          default: {
            const _exhaustive: never = result;
            return _exhaustive;
          }
        }
      } catch (error) {
        const normalized = normalizeError(error);
        await this.reportError(normalized, "before_tool", event.head);
        return { action: "error", message: normalized.message };
      }
    }
    return modified === undefined ? { action: "continue" } : { action: "modify", args: modified };
  }

  private async afterTool(
    event: HookInvocation<"after_tool">,
    signal: AbortSignal | undefined,
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
        const result = (await registration.handler(
          { ...event, ...current },
          signal,
        )) as HookMap["after_tool"]["result"];
        if (result === undefined) continue;
        if (result.content !== undefined) aggregate.content = result.content;
        if (result.details !== undefined) aggregate.details = result.details;
        if (result.isError !== undefined) aggregate.isError = result.isError;
        if (result.usage !== undefined) aggregate.usage = result.usage;
        current = {
          content: result.content ?? current.content,
          details: result.details ?? current.details,
          isError: result.isError ?? current.isError,
          usage: result.usage ?? current.usage,
        };
      } catch (error) {
        await this.reportError(normalizeError(error), "after_tool", event.head);
      }
    }
    return Object.keys(aggregate).length === 0 ? undefined : aggregate;
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
