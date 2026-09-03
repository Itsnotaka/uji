/**
 * Steers and follow-ups core is still holding, drawn between the transcript
 * and the composer.
 *
 * These messages have not been sent. The transcript is an append-only record,
 * so drawing them inside it made a mutable list look like history: consuming
 * one deleted a block from the middle and shifted everything below it, and
 * scrolling up hid the one thing worth taking back. They live in their own
 * region instead, a sibling of the scroll box, pinned above the composer where
 * the next thing you send is already in view.
 *
 * One row per item, because a pending message is a promise about a line of
 * text and not a turn: the glyph and one word say when it goes, and the row
 * closest to the composer carries the key that takes it back. Core has two
 * delivery modes, so the vocabulary here has two words.
 *
 * Core's queue events are the only source: `queued` adds or moves a row,
 * `queue_consumed` and `queue_cancelled` remove it, and one `messages.pending`
 * read at wire time shows what a resumed session left pending.
 *
 * Based on opencode's queued user messages, which render with a QUEUED badge
 * until their turn begins:
 * https://github.com/anomalyco/opencode/blob/7cde8329bc33801248d6aafa2a4dd46dc86e5683/packages/tui/src/routes/session/index.tsx
 */
import { BoxRenderable, fg, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import type { PendingItem } from "@uji-ai/core";
import { DELIVERY, GLYPHS, pendingHint } from "./constants.ts";
import { partsText } from "./format.ts";
import type { CliTheme } from "./theme.ts";
import { displayWidth, padDisplay, truncateDisplay } from "./width.ts";

type Delivery = PendingItem["delivery"];

/**
 * The gutter never takes more than this share of the terminal. A long queue
 * summarizes its tail instead of pushing the transcript off the screen, since
 * the point of the region is to sit beside the conversation, not replace it.
 */
const MAX_ROW_SHARE = 0.3;
const MIN_ROWS = 1;

function gutterRowLimit(terminalHeight: number): number {
  return Math.max(MIN_ROWS, Math.floor(terminalHeight * MAX_ROW_SHARE));
}

/** Below this the message is a stub, so the row sheds chrome to keep the text. */
const MIN_TEXT_COLUMNS = 12;
/** Leading space, glyph, trailing space. */
const LEAD_COLUMNS = 3;
/** Between the message and the delivery word. The right margin is counted separately. */
const GAP_COLUMNS = 2;

/** A pending message on one line: no newlines, no runs of blank space. */
function pendingText(item: PendingItem): string {
  return partsText(item.content).replaceAll(/\s+/gu, " ").trim();
}

/**
 * The message enter sends on an empty composer: the one at the front of the
 * queue that is still waiting for the run to end. A steer is already going out
 * at the next boundary, so pressing enter at it would mean nothing.
 *
 * Based on OpenCode v2, where enter on an empty prompt steers the first queued
 * prompt:
 * https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/routes/session/index.tsx
 */
export function nextToSteer(items: readonly PendingItem[]): PendingItem | undefined {
  return items.find((item) => item.delivery !== "steer");
}

/**
 * `<glyph> <message>   <word> · <key>`, with the message taking whatever the
 * fixed parts leave. Chrome goes before the delivery word when the terminal
 * narrows, because which mode a message is in outranks the key that changes it.
 */
function pendingRow(
  text: string,
  delivery: Delivery,
  width: number,
  theme: CliTheme,
  hint?: string,
): StyledText {
  const mark = DELIVERY[delivery];
  const tone = theme[mark.tone];
  const room = Math.max(0, Math.floor(width));
  // A row that outgrows its width wraps, and a wrapped row is two rows, which
  // breaks the one-message-one-line rule the region is built on. Below the
  // glyph's own width there is nothing left to lay out.
  const lead = ` ${mark.glyph} `;
  if (room <= LEAD_COLUMNS) {
    return new StyledText([fg(tone)(padDisplay(truncateDisplay(lead, room), room))]);
  }
  // A trailing column on every row, so the region has an even right edge
  // whether or not the delivery word survived the width.
  const fixed = LEAD_COLUMNS + 1;

  const fits = (right: string): boolean =>
    room - fixed - GAP_COLUMNS - displayWidth(right) >= MIN_TEXT_COLUMNS;
  const showLabel = fits(mark.label);
  const showHint = hint !== undefined && fits(`${mark.label} \u00b7 ${hint}`);

  const right = showLabel ? mark.label : "";
  const textRoom = Math.max(
    0,
    room -
      fixed -
      (showLabel ? GAP_COLUMNS + displayWidth(right) : 0) -
      (showHint ? displayWidth(` \u00b7 ${hint}`) : 0),
  );

  const chunks = [
    fg(tone)(lead),
    fg(theme.user)(padDisplay(truncateDisplay(text, textRoom, GLYPHS.ellipsis), textRoom)),
  ];
  if (showLabel) chunks.push(fg(theme.muted)("  "), fg(tone)(right));
  if (showHint) chunks.push(fg(theme.muted)(" \u00b7 "), fg(theme.dim)(hint));
  chunks.push(fg(theme.muted)(" "));
  return new StyledText(chunks);
}

/**
 * The region itself. Hidden while nothing is pending, so an idle session gives
 * every row it owns back to the transcript.
 */
export class PendingGutter {
  readonly container: BoxRenderable;
  private readonly renderer: CliRenderer;
  private readonly theme: CliTheme;
  private readonly nextId: (prefix?: string) => string;
  private items: readonly PendingItem[] = [];
  private readonly rows: TextRenderable[] = [];

  constructor(renderer: CliRenderer, theme: CliTheme, nextId: (prefix?: string) => string) {
    this.renderer = renderer;
    this.theme = theme;
    this.nextId = nextId;
    this.container = new BoxRenderable(renderer, {
      id: "pending-gutter",
      flexDirection: "column",
      flexShrink: 0,
      visible: false,
      backgroundColor: theme.terminal,
      marginLeft: 1,
      marginRight: 1,
    });
    this.container.onSizeChange = this.repaint;
  }

  /** The last list core reported, including rows the height cap is hiding. */
  get pending(): readonly PendingItem[] {
    return this.items;
  }

  /** A shorter terminal fits fewer rows, so the cap is re-taken on resize. */
  resize(): void {
    this.sync(this.items);
  }

  /** Repaint colors after the shared theme object changes. */
  retheme(): void {
    this.container.backgroundColor = this.theme.terminal;
    this.repaint();
  }

  sync(items: readonly PendingItem[]): void {
    this.items = items;
    this.setRowCount(Math.min(items.length, gutterRowLimit(this.renderer.height)));
    this.repaint();
  }

  /** Core reported the item: a new row, or a lane change on one already shown. */
  upsert(item: PendingItem): void {
    const index = this.items.findIndex((shown) => shown.entryId === item.entryId);
    this.sync(index === -1 ? [...this.items, item] : this.items.with(index, item));
  }

  /** Core consumed or cancelled the item, so its row leaves. */
  resolve(entryId: string): void {
    if (!this.items.some((item) => item.entryId === entryId)) return;
    this.sync(this.items.filter((item) => item.entryId !== entryId));
  }

  /**
   * Drops the rows but keeps the list, because `replaceTranscript` clears the
   * whole view and then hands `pending` straight back to `sync`.
   */
  clear(): void {
    this.setRowCount(0);
  }

  private setRowCount(count: number): void {
    while (this.rows.length > count) {
      const row = this.rows.pop();
      if (row === undefined) continue;
      this.container.remove(row);
      if (!row.isDestroyed) row.destroyRecursively();
    }
    while (this.rows.length < count) {
      const row = new TextRenderable(this.renderer, {
        id: this.nextId("pending-row"),
        content: "",
        height: 1,
        wrapMode: "none",
        selectable: false,
      });
      this.rows.push(row);
      this.container.add(row);
    }
    this.container.visible = count > 0;
  }

  private readonly repaint = (): void => {
    const width =
      this.container.width > 0 ? this.container.width : Math.max(0, this.renderer.width - 2);
    const shown = this.rows.length;
    const hidden = this.items.length - shown;
    for (const [index, row] of this.rows.entries()) {
      const item = this.items[index];
      if (item === undefined) continue;
      // The key that takes a message back is stated once, on the row nearest
      // the composer, rather than on every row that could use it.
      const last = index === shown - 1;
      row.content = pendingRow(
        pendingText(item),
        item.delivery,
        width,
        this.theme,
        last ? pendingHint(hidden) : undefined,
      );
    }
  };
}
