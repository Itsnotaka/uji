import { MODEL_THINKING_LEVELS } from "@uji-ai/schema";
import type { ThinkingLevelMap } from "../src/types.ts";

export type ModelsDevReasoningOption =
  | { type: "toggle" }
  | {
      type: "effort";
      values: Array<
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null
      >;
    }
  | { type: "budget_tokens"; min?: number; max?: number };

/**
 * Converts models.dev verified effort values into Pi's selectable thinking levels.
 * Values without a Pi equivalent (`default` and JSON `null`) are intentionally
 * omitted.
 */
export function getEffortThinkingLevelMap(
  options: readonly ModelsDevReasoningOption[],
): ThinkingLevelMap | undefined {
  const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
  if (effortValues.length === 0) return undefined;

  const supported = new Set(effortValues);
  if (
    !MODEL_THINKING_LEVELS.some((level) => level !== "off" && supported.has(level)) &&
    !supported.has("none")
  ) {
    return undefined;
  }

  const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
  for (const level of MODEL_THINKING_LEVELS) {
    if (level === "off") continue;
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}
