import type { CacheRetention, PromptCachePolicy, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

/** Resolve the request preference shared by cache-aware provider adapters and hosts. */
export function resolveCacheRetention(
  retention?: CacheRetention,
  env?: ProviderEnv,
): CacheRetention {
  if (retention !== undefined) return retention;
  return getProviderEnvValue("PI_CACHE_RETENTION", env) === "long" ? "long" : "short";
}

/** The provider's minimum warm window for the requested retention mode. */
export function promptCacheMinimumTtlMs(
  policy: PromptCachePolicy | undefined,
  retention: CacheRetention,
): number | undefined {
  if (policy === undefined || retention === "none") return undefined;
  return policy.minimumRetentionMs[retention];
}
