/**
 * A settled stretch of related tool calls folds to one quiet work row and
 * expands in place. The row borrows Honk's hierarchy while preserving Uji's
 * TUI grouping modes and core-owned tool presentation.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/ui/src/work-group.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactElement } from "react";
import type { ToolProgress, ToolTurnPart } from "@uji-ai/core";
import { Icon } from "../components/icons.tsx";
import { focus } from "../components/ui.tsx";
import { activityStyles, toolGroupStyles } from "./styles.stylex.ts";
import { ToolCallView } from "./tool-call.tsx";
import { presentTool } from "./tool-detail.ts";

function toolSummary(parts: readonly ToolTurnPart[]): string {
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.toolName, (counts.get(part.toolName) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${String(count)} ${name}`).join(" · ");
}

export function ToolGroupView({
  parts,
  liveTools,
  cwd,
}: {
  parts: readonly ToolTurnPart[];
  liveTools: ReadonlyMap<string, { entryId: string; progress: ToolProgress }>;
  cwd: string | undefined;
}): ReactElement {
  const presentations = parts.map((part) =>
    presentTool(part, liveTools.get(part.callId)?.progress, cwd),
  );
  const running = presentations.some((presentation) => presentation.state === "running");
  const failed = presentations.some((presentation) => presentation.state === "failed");
  const added = presentations.reduce((total, presentation) => total + (presentation.added ?? 0), 0);
  const removed = presentations.reduce(
    (total, presentation) => total + (presentation.removed ?? 0),
    0,
  );
  const [open, setOpen] = useState<boolean | undefined>();
  const expanded = open ?? running;

  return (
    <div {...stylex.props(toolGroupStyles.root)}>
      <button
        type="button"
        aria-expanded={expanded}
        {...stylex.props(toolGroupStyles.toggle, focus.ring, failed && toolGroupStyles.failed)}
        onClick={() => setOpen(!expanded)}
      >
        <span {...stylex.props(toolGroupStyles.verb, running && activityStyles.shimmer)}>
          {running ? "Working" : failed ? "Work failed" : "Worked"}
        </span>
        <span {...stylex.props(toolGroupStyles.summary)}>{toolSummary(parts)}</span>
        {(added > 0 || removed > 0) && (
          <span {...stylex.props(toolGroupStyles.stats)}>
            {added > 0 && <span {...stylex.props(toolGroupStyles.added)}>+{added}</span>}
            {removed > 0 && <span {...stylex.props(toolGroupStyles.removed)}>-{removed}</span>}
          </span>
        )}
        <span {...stylex.props(toolGroupStyles.chevron, expanded && toolGroupStyles.chevronOpen)}>
          <Icon name="chevron-right" size={11} />
        </span>
      </button>
      {expanded && (
        <div {...stylex.props(toolGroupStyles.calls)}>
          {parts.map((part) => (
            <ToolCallView
              key={part.callId}
              part={part}
              progress={liveTools.get(part.callId)?.progress}
              cwd={cwd}
              display="compact"
            />
          ))}
        </div>
      )}
    </div>
  );
}
