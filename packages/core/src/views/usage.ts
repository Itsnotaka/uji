/**
 * Usage totals folded from a session's durable entries. Assistant messages
 * self-report model and usage; compaction and tool executions report usage
 * without a model, so each gets its own bucket. Every branch counts: tokens
 * spent on an abandoned branch were still spent.
 */
import type { Usage } from "@uji-ai/schema";
import { addUsage, emptyUsage } from "../harness/utils/usage.ts";
import type { Entry, UsageRecord } from "../harness/session/types.ts";

export interface ModelUsage {
  readonly model: string;
  /** Assistant messages folded into this row. */
  readonly turns: number;
  readonly usage: Usage;
}

export interface UsageSummary {
  /** Highest cost first, then most tokens, then model id, so output is stable. */
  readonly models: readonly ModelUsage[];
  /** Summarization spend (compaction and branch summaries); neither carries a model id. */
  readonly compaction: Usage;
  /** Usage reported by tool executions, outside main context accounting. */
  readonly tools: Usage;
  readonly total: Usage;
}

export function emptyUsageSummary(): UsageSummary {
  return { models: [], compaction: emptyUsage(), tools: emptyUsage(), total: emptyUsage() };
}

function sortModels(models: ReadonlyMap<string, { turns: number; usage: Usage }>): ModelUsage[] {
  return [...models]
    .map(([model, { turns, usage }]) => ({ model, turns, usage }))
    .toSorted(
      (left, right) =>
        right.usage.cost.total - left.usage.cost.total ||
        right.usage.totalTokens - left.usage.totalTokens ||
        left.model.localeCompare(right.model),
    );
}

function summarize(
  models: ReadonlyMap<string, { turns: number; usage: Usage }>,
  compaction: Usage,
  tools: Usage,
): UsageSummary {
  const sorted = sortModels(models);
  const total = [...sorted.map((row) => row.usage), compaction, tools].reduce(
    addUsage,
    emptyUsage(),
  );
  return { models: sorted, compaction, tools, total };
}

/** Sum the committed usage ledger for one run. */
export function projectRunUsage(records: readonly UsageRecord[]): Usage {
  return records.reduce((sum, record) => addUsage(sum, record.usage), emptyUsage());
}

/** Fold every entry of one session, current branch and abandoned ones alike. */
export function projectUsage(entries: readonly Entry[]): UsageSummary {
  const models = new Map<string, { turns: number; usage: Usage }>();
  let compaction = emptyUsage();
  let tools = emptyUsage();

  for (const entry of entries) {
    switch (entry.type) {
      case "message": {
        const { message } = entry;
        switch (message.role) {
          case "assistant": {
            const bucket = models.get(message.model) ?? { turns: 0, usage: emptyUsage() };
            models.set(message.model, {
              turns: bucket.turns + 1,
              usage: addUsage(bucket.usage, message.usage),
            });
            break;
          }
          case "toolResult":
            if (message.usage !== undefined) tools = addUsage(tools, message.usage);
            break;
          case "user":
            break;
          default: {
            const _exhaustive: never = message;
            return _exhaustive;
          }
        }
        break;
      }
      case "compaction":
      case "branch_summary":
        if (entry.usage !== undefined) compaction = addUsage(compaction, entry.usage);
        break;
      case "model_change":
      case "thinking_level_change":
      case "agent_change":
      case "custom":
        break;
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  }

  return summarize(models, compaction, tools);
}

/** Combine per-session summaries into a workspace-wide one. */
export function mergeUsageSummaries(left: UsageSummary, right: UsageSummary): UsageSummary {
  const models = new Map<string, { turns: number; usage: Usage }>();
  for (const row of [...left.models, ...right.models]) {
    const bucket = models.get(row.model) ?? { turns: 0, usage: emptyUsage() };
    models.set(row.model, {
      turns: bucket.turns + row.turns,
      usage: addUsage(bucket.usage, row.usage),
    });
  }
  return summarize(
    models,
    addUsage(left.compaction, right.compaction),
    addUsage(left.tools, right.tools),
  );
}
