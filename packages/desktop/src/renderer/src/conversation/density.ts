import type { ToolTurnPart, TurnPart } from "@uji-ai/core";
import type { ToolCallDisplay } from "../theme/boot.ts";

const DETAILED_TOOLS = new Set(["edit", "write"]);

export type DisplayPart =
  | { readonly kind: "part"; readonly part: TurnPart }
  | { readonly kind: "tools"; readonly parts: readonly ToolTurnPart[] };

function groupedInMode(part: TurnPart, mode: ToolCallDisplay): part is ToolTurnPart {
  if (part.kind !== "tool" || mode === "detailed") return false;
  return mode === "compact" || !DETAILED_TOOLS.has(part.toolName);
}

/**
 * The desktop counterpart to TUI's tool grouping law: auto keeps edits and
 * writes detailed, compact groups those too, and detailed groups nothing.
 */
export function displayParts(parts: readonly TurnPart[], mode: ToolCallDisplay): DisplayPart[] {
  const display: DisplayPart[] = [];
  let pending: ToolTurnPart[] = [];

  const flush = (): void => {
    if (pending.length === 1) display.push({ kind: "part", part: pending[0] });
    else if (pending.length > 1) display.push({ kind: "tools", parts: pending });
    pending = [];
  };

  for (const part of parts) {
    if (groupedInMode(part, mode)) {
      pending.push(part);
      continue;
    }
    flush();
    display.push({ kind: "part", part });
  }
  flush();
  return display;
}
