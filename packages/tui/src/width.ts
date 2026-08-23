import stringWidth from "string-width";

const segmenter = new Intl.Segmenter();

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

/** Terminal cells occupied by plain text, using the same Unicode rules as OpenTUI. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function padDisplay(text: string, width: number): string {
  const room = width - displayWidth(text);
  return room > 0 ? text + " ".repeat(room) : text;
}

/** Cut at grapheme boundaries so a double-width cell is never split. */
export function truncateDisplay(text: string, width: number, ellipsis = ""): string {
  if (displayWidth(text) <= width) return text;
  const budget = Math.max(0, width - displayWidth(ellipsis));
  let kept = "";
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const cells = displayWidth(grapheme);
    if (used + cells > budget) break;
    kept += grapheme;
    used += cells;
  }
  return `${kept}${displayWidth(ellipsis) <= width ? ellipsis : ""}`;
}
