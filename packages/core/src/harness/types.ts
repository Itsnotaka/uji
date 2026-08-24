/**
 * Harness-level contracts that sit above the loop: the tool a harness runs
 * (six arguments: it knows its invocation and receives an execution context),
 * the resources a harness holds for the model (skills, prompt templates), and
 * the provider request options the harness snapshots per turn and lets hooks
 * patch.
 *
 * The loop's own `AgentTool` (four arguments, a bare signal) stays unchanged in
 * `src/types.ts`; the harness binds an `AgentHarnessTool` into that shape when
 * it drives the loop. This keeps the loop free of harness imports.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/types.ts
 * Synced with pi 7ebf9087e.
 */
import type { CacheRetention, Transport } from "@uji-ai/ai";
import type { PromptTemplate, Skill } from "@uji-ai/schema";
import type { Static, TSchema } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";
import type { Context } from "./context.ts";

export type { PromptTemplate, Skill } from "@uji-ai/schema";

/** Resources made available to explicit invocation methods and system-prompt callbacks. */
export interface AgentHarnessResources<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
  /** Prompt templates available for explicit invocation. */
  promptTemplates?: TPromptTemplate[];
  /** Skills available to the model and explicit skill invocation. */
  skills?: TSkill[];
}

/** Stable harness identity for one logical tool call, unchanged during safe replay. */
export interface AgentHarnessToolInvocation {
  /** Opaque session-unique id equal to the call's reserved result-entry id. */
  invocationId: string;
  operationId: string;
  turnId: string;
}

/** Tool definition executed by the harness with an application-defined context. */
export type AgentHarnessTool<
  TContext extends object | undefined = object | undefined,
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> = Omit<AgentTool<TParameters, TDetails>, "execute"> & {
  /** Crash-replay policy. `safe` re-executes an unsettled call on resume; `never` (default) settles it as an error. */
  replay?: "never" | "safe";
  /** Execute the tool call with the context resolved for the current turn snapshot. */
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    toolContext: TContext,
    invocation: AgentHarnessToolInvocation,
    context: Context,
  ): Promise<AgentToolResult<TDetails>>;
};

/** A harness tool whose parameter and detail types are intentionally erased. */
export type AnyAgentHarnessTool<TContext extends object | undefined = object | undefined> =
  AgentHarnessTool<TContext, any, any>;

/** Static tool context or provider resolved for each turn snapshot. */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
  | TContext
  | ((context: Context) => TContext | Promise<TContext>);

/**
 * Curated provider request options owned by the harness and snapshotted per turn.
 * Uji's StreamFn carries fewer knobs than pi's today; fields are added here as
 * `@uji-ai/ai` grows them, never invented ahead of the adapter.
 */
export interface AgentHarnessStreamOptions {
  /** Maximum provider retry attempts. */
  maxRetries?: number;
  /** Optional cap for provider-requested retry delays. */
  maxRetryDelayMs?: number;
  /** Preferred transport for providers that support more than one. */
  transport?: Transport;
  /** Prompt cache retention preference. */
  cacheRetention?: CacheRetention;
  /** Request the selected model's advertised fast inference mode. */
  fast?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Additional request headers merged with auth and lifecycle headers. */
  headers?: Record<string, string>;
  /** Sampling parameters merged into the request body by OpenAI-compatible adapters. */
  samplingParams?: Record<string, unknown>;
}

/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch extends Omit<
  Partial<AgentHarnessStreamOptions>,
  "headers" | "samplingParams"
> {
  /** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
  headers?: Record<string, string | undefined>;
  /** Sampling patch. `undefined` values delete keys; explicit `samplingParams: undefined` clears them. */
  samplingParams?: Record<string, unknown>;
}
