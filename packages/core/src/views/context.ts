import {
  calculateContextTokens,
  estimateContextTokens,
  getLastAssistantUsage,
} from "../harness/compaction/compaction.ts";
import { buildSessionContext } from "../harness/session/context.ts";
import type { Entry } from "../harness/session/types.ts";

export interface ContextStatus {
  /** Estimated tokens in the context that would be sent on the next step. */
  readonly estimatedTokens: number;
  /** Tokens reported by the last settled assistant turn, when available. */
  readonly lastTurnTokens?: number;
  /** Tokens covered by the latest provider usage report. */
  readonly usageTokens: number;
  /** Locally estimated tokens appended after the latest usage report. */
  readonly trailingTokens: number;
  readonly contextWindow: number;
  readonly percent?: number;
}

/** Project context and last-turn usage from one durable branch. */
export function projectContextStatus(
  entries: readonly Entry[],
  contextWindow: number,
): ContextStatus {
  const estimate = estimateContextTokens(buildSessionContext(entries));
  const lastUsage = getLastAssistantUsage(entries);
  return {
    estimatedTokens: estimate.tokens,
    usageTokens: estimate.usageTokens,
    trailingTokens: estimate.trailingTokens,
    contextWindow,
    ...(lastUsage === undefined ? {} : { lastTurnTokens: calculateContextTokens(lastUsage) }),
    ...(contextWindow > 0 ? { percent: Math.round((estimate.tokens / contextWindow) * 100) } : {}),
  };
}
