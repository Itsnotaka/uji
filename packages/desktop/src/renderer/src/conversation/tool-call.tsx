/**
 * One tool call: a quiet verb line that expands into its evidence. Ported from
 * the Honk design system's `tool-call.tsx` and recolored onto this palette.
 * Its locked law carries over: no status icons on tool calls — the running
 * state is the shimmer, failure is the red line, and the chevron is a
 * control, not a status.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/ui/src/tool-call.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactElement } from "react";
import type { ToolProgress, ToolTurnPart } from "@uji-ai/core";
import { Icon } from "../components/icons.tsx";
import { focus } from "../components/ui.tsx";
import type { ToolCallDisplay } from "../theme/boot.ts";
import { DiffCard } from "./diff-view.tsx";
import { activityStyles, toolCallStyles } from "./styles.stylex.ts";
import { presentTool } from "./tool-detail.ts";

export function ToolCallView({
  part,
  progress,
  cwd,
  display = "auto",
}: {
  part: ToolTurnPart;
  progress: ToolProgress | undefined;
  cwd: string | undefined;
  display?: ToolCallDisplay;
}): ReactElement {
  const presentation = presentTool(part, progress, cwd);
  const [open, setOpen] = useState<boolean | undefined>();
  const expandable = presentation.body.kind !== "none";
  const initiallyOpen =
    display === "detailed" || (display === "auto" && presentation.body.kind === "diff");
  const isOpen = open ?? initiallyOpen;
  const running = presentation.state === "running";
  const lineContent = (
    <>
      <span {...stylex.props(toolCallStyles.verb, running && activityStyles.shimmer)}>
        {presentation.verb}
      </span>
      {presentation.detail !== undefined && (
        <span {...stylex.props(toolCallStyles.detail)}>{presentation.detail}</span>
      )}
      {(presentation.added !== undefined || presentation.removed !== undefined) && (
        <span {...stylex.props(toolCallStyles.stats)}>
          {presentation.added !== undefined && (
            <span {...stylex.props(toolCallStyles.added)}>+{presentation.added}</span>
          )}
          {presentation.removed !== undefined && (
            <span {...stylex.props(toolCallStyles.removed)}>-{presentation.removed}</span>
          )}
        </span>
      )}
    </>
  );

  return (
    <div {...stylex.props(toolCallStyles.root)}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setOpen(!isOpen)}
          data-tool-status={presentation.state}
          {...stylex.props(
            toolCallStyles.line,
            focus.ring,
            presentation.state === "failed" && toolCallStyles.failed,
          )}
        >
          {lineContent}
          <span {...stylex.props(toolCallStyles.chevron, isOpen && toolCallStyles.chevronOpen)}>
            <Icon name="chevron-right" size={12} />
          </span>
        </button>
      ) : (
        <div
          data-tool-status={presentation.state}
          {...stylex.props(
            toolCallStyles.line,
            toolCallStyles.lineStatic,
            presentation.state === "failed" && toolCallStyles.failed,
          )}
        >
          {lineContent}
        </div>
      )}

      {isOpen && presentation.body.kind === "output" && (
        <div
          role="region"
          aria-label={`${presentation.verb} output`}
          data-uji-scrollport
          {...stylex.props(toolCallStyles.output)}
        >
          {presentation.body.text}
        </div>
      )}
      {isOpen && presentation.body.kind === "diff" && (
        <DiffCard path={presentation.body.path} diff={presentation.body.diff} />
      )}
    </div>
  );
}
