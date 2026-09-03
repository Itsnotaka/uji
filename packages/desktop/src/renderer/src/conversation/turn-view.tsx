/**
 * One transcript item. User prompts are the only ordinary contained message
 * region. Assistant prose stays flat, while reasoning, tools, and system
 * history use compact rows. Parts keep core's stable identity so settled and
 * streaming content exchange in place.
 */
import * as stylex from "@stylexjs/stylex";
import { memo, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { presentCustomEntry, turnPartId } from "@uji-ai/core/views";
import type { ToolProgress, Turn, TurnPart, UserTurnPart } from "@uji-ai/core";
import { Icon } from "../components/icons.tsx";
import { focus } from "../components/ui.tsx";
import type { ToolCallDisplay } from "../theme/boot.ts";
import { useAppearanceSettings } from "../theme/use-appearance.ts";
import { displayParts } from "./density.ts";
import { Prose } from "./prose.tsx";
import { turnStyles } from "./styles.stylex.ts";
import { ToolCallView } from "./tool-call.tsx";
import { ToolGroupView } from "./tool-group.tsx";

function contentText(content: UserTurnPart["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          return "[image]";
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    })
    .join("");
}

function isErrorText(text: string): boolean {
  return /^error\s*:/iu.test(text.trim());
}

export function ReasoningBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): ReactElement {
  const [open, setOpen] = useState<boolean | undefined>();
  const bodyId = useId();
  const isOpen = open ?? streaming;
  return (
    <div aria-busy={streaming || undefined} {...stylex.props(turnStyles.reasoning)}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={() => setOpen(!isOpen)}
        {...stylex.props(turnStyles.reasoningToggle, focus.ring)}
      >
        <span
          aria-hidden="true"
          {...stylex.props(turnStyles.reasoningChevron, isOpen && turnStyles.reasoningChevronOpen)}
        >
          <Icon name="chevron-right" size={11} />
        </span>
        {streaming ? "Thinking…" : "Reasoning"}
      </button>
      {isOpen && text !== "" && (
        <div id={bodyId} {...stylex.props(turnStyles.reasoningBody)}>
          {text}
        </div>
      )}
    </div>
  );
}

function Marker({ children }: { children: ReactNode }): ReactElement {
  return (
    <div {...stylex.props(turnStyles.marker)}>
      <span aria-hidden="true" {...stylex.props(turnStyles.markerRule)} />
      <span {...stylex.props(turnStyles.markerLabel)}>{children}</span>
      <span aria-hidden="true" {...stylex.props(turnStyles.markerRule)} />
    </div>
  );
}

function Notice({ text, error = false }: { text: string; error?: boolean }): ReactElement {
  return (
    <div
      role={error ? "alert" : "status"}
      {...stylex.props(turnStyles.notice, error && turnStyles.noticeError)}
    >
      {error && <span aria-hidden="true">!</span>}
      <span>{text}</span>
    </div>
  );
}

export function TurnPartView({
  part,
  liveTools,
  cwd,
  toolCalls,
}: {
  part: TurnPart;
  liveTools: ReadonlyMap<string, { entryId: string; progress: ToolProgress }>;
  cwd: string | undefined;
  toolCalls: ToolCallDisplay;
}): ReactElement | null {
  switch (part.kind) {
    case "user":
      return (
        <div {...stylex.props(turnStyles.userRow)}>
          <div {...stylex.props(turnStyles.userPrompt)}>{contentText(part.content)}</div>
        </div>
      );
    case "assistant":
      return part.text.trim() === "" ? null : <Prose markdown={part.text} />;
    case "thinking":
      return part.text.trim() === "" ? null : <ReasoningBlock text={part.text} streaming={false} />;
    case "tool":
      return (
        <ToolCallView
          part={part}
          progress={liveTools.get(part.callId)?.progress}
          cwd={cwd}
          display={toolCalls}
        />
      );
    case "note":
      return <Notice text={part.text} error={isErrorText(part.text)} />;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

export const TurnView = memo(function TurnView({
  turn,
  liveTools,
  cwd,
}: {
  turn: Turn;
  liveTools: ReadonlyMap<string, { entryId: string; progress: ToolProgress }>;
  cwd: string | undefined;
}): ReactElement | null {
  const appearance = useAppearanceSettings();
  switch (turn.kind) {
    case "turn": {
      const hasErrorNote = turn.parts.some(
        (part) => part.kind === "note" && isErrorText(part.text),
      );
      return (
        <div {...stylex.props(turnStyles.turn)}>
          {displayParts(turn.parts, appearance.toolCalls).map((item) =>
            item.kind === "tools" ? (
              <ToolGroupView
                key={`tools:${item.parts[0]?.callId ?? turn.id}`}
                parts={item.parts}
                liveTools={liveTools}
                cwd={cwd}
              />
            ) : (
              <TurnPartView
                key={turnPartId(item.part)}
                part={item.part}
                liveTools={liveTools}
                cwd={cwd}
                toolCalls={appearance.toolCalls}
              />
            ),
          )}
          {turn.outcome === "aborted" && <Notice text="Run interrupted" />}
          {turn.outcome === "failed" && !hasErrorNote && <Notice text="Run failed" error />}
        </div>
      );
    }
    case "compaction":
      return (
        <Marker>
          <Icon name="sparkle" size={12} />
          Context compacted
        </Marker>
      );
    case "model_change":
      return <Marker>Model changed to {turn.entry.modelId}</Marker>;
    case "branch_summary":
      return (
        <div {...stylex.props(turnStyles.summary)}>
          <span {...stylex.props(turnStyles.summaryLabel)}>Branch summary</span>
          <div {...stylex.props(turnStyles.summaryText)}>{turn.entry.summary}</div>
        </div>
      );
    case "custom":
      return <Notice text={presentCustomEntry(turn.entry).text} />;
    default: {
      const _exhaustive: never = turn;
      return _exhaustive;
    }
  }
});
