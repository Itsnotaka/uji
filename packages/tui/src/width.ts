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

/**
 * The offset OpenTUI's cursor and extmarks count in: terminal cells, with each
 * newline counting as one. Composer code moves between this space and plain
 * string indices constantly, so both directions live here.
 */
export function cellOffset(text: string, index: number): number {
  const lines = text.slice(0, index).split("\n");
  return lines.reduce((sum, line) => sum + displayWidth(line), lines.length - 1);
}

/** The string index at a cell offset, rounded to the grapheme that holds it. */
export function cellIndex(text: string, offset: number): number {
  let cells = 0;
  let index = 0;
  for (const grapheme of graphemes(text)) {
    if (cells >= offset) return index;
    cells += grapheme === "\n" ? 1 : displayWidth(grapheme);
    index += grapheme.length;
  }
  return text.length;
}
