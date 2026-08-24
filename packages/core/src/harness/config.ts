/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/config.ts
 * Synced with pi d4edf066f.
 */
import type { RetryPolicy } from "@uji-ai/ai";
import type { CompactionSettings } from "./compaction/compaction.ts";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1_000,
};

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.maxRetries) ||
    policy.maxRetries < 0 ||
    policy.maxRetries === Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(policy.baseDelayMs) ||
    policy.baseDelayMs < 0
  ) {
    throw new RangeError("Retry policy values must be finite non-negative safe integers");
  }
}

export function validateCompactionSettings(settings: CompactionSettings): void {
  if (
    !Number.isSafeInteger(settings.reserveTokens) ||
    settings.reserveTokens < 0 ||
    !Number.isSafeInteger(settings.keepRecentTokens) ||
    settings.keepRecentTokens < 0
  ) {
    throw new RangeError("Compaction token counts must be finite non-negative safe integers");
  }
}
