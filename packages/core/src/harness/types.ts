/**
 * The provider request options the harness snapshots per turn and lets
 * `before_request` hooks patch.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/types.ts
 * Synced with pi 7ebf9087e.
 */
import type { CacheRetention, Transport } from "@uji-ai/ai";

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
