/**
 * One-row status line with Powerline-style segments. It uses a standard box
 * character instead of a patched-font glyph, so it renders in stock terminal
 * fonts. The words alone carry the meaning; see `powerlineText` in format.ts.
 */
import { StyledText, bold, fg } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import { POWERLINE_SEPARATOR, powerlineSegments } from "./format.ts";
import type { PowerlineSegment, PowerlineState } from "./format.ts";
import type { CliTheme } from "./theme.ts";

function segmentColor(segment: PowerlineSegment, state: PowerlineState, theme: CliTheme): string {
  if (segment.tone === "state") {
    if (state.runState === "idle") return theme.ok;
    if (state.runState === "running tool") return theme.tool;
    return theme.user;
  }
  if (segment.tone === "model") return theme.user;
  if (segment.tone === "queue") return theme.tool;
  return theme.dim;
}

export function powerlineStyled(state: PowerlineState, theme: CliTheme): StyledText {
  const chunks: TextChunk[] = [];
  for (const [index, segment] of powerlineSegments(state).entries()) {
    if (index === 0) chunks.push(fg(theme.dim)(" "));
    else chunks.push(fg(theme.dim)(` ${POWERLINE_SEPARATOR} `));
    const body = fg(segmentColor(segment, state, theme))(segment.text);
    chunks.push(segment.tone === "state" || segment.tone === "queue" ? bold(body) : body);
  }
  return new StyledText(chunks);
}
