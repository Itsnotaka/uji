/**
 * The rows under the composer that the terminal takes back.
 *
 * The transcript is the record, so a row painted there is permanent and may
 * only carry what core logged. Everything the client says about itself goes
 * here instead: a model switch, a login, `/usage`, "Nothing is queued". So do
 * the panels that come and go, the slash dropdown and every inline menu.
 *
 * The slot borrows its rows rather than taking them. A flex child under the
 * composer shrinks the transcript's viewport, and a shrinking viewport
 * re-anchors `stickyStart: "bottom"`, which moves every visible row and
 * repaints the screen. So the slot cancels its own height back out of the
 * column with a negative margin on the transcript. The viewport keeps the
 * height it had, nothing re-anchors, and the composer rides up over the
 * transcript's tail as far as the slot is tall. Opening a 12-row menu on a
 * long chat writes 935 cells instead of 2880 and moves no transcript row.
 *
 * Panels declare their row count; nothing measures it. Reading
 * `container.height` back from yoga costs a frame, and that frame of lag is
 * the jolt this exists to remove. Both panels already size their own list, so
 * the number is there for the asking.
 */
import { BoxRenderable, fg, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import type { CliTheme } from "./theme.ts";

/**
 * A notice never takes more than this share of the terminal, so a long
 * `/plugins` list cannot bury the conversation it is reporting on.
 */
const MAX_NOTICE_SHARE = 0.4;

function noticeRowLimit(terminalHeight: number): number {
  return Math.max(1, Math.floor(terminalHeight * MAX_NOTICE_SHARE));
}

/**
 * Something that can hold the slot. It declares the rows it needs, owns the
 * keyboard while it is up, and closes on escape. The menu behind `/settings`
 * and the `/usage` card are the same thing to the shell.
 */
export interface EphemeralPanel {
  readonly container: BoxRenderable;
  /** Rows to borrow. Declared, never measured. */
  readonly rows: number;
  /** Keycap row the shell shows while this panel owns the input. */
  readonly hints: string;
  focus: () => void;
  blur: () => void;
  destroy: () => void;
}

/** What the slot is showing. Empty is a state, not a missing panel. */
type Occupant =
  | { kind: "empty" }
  | { kind: "notice"; lines: readonly string[]; color: string | undefined }
  | { kind: "panel"; container: BoxRenderable };

export class Ephemeral {
  /** Sits below the composer, above the hint row. */
  readonly container: BoxRenderable;

  private readonly renderer: CliRenderer;
  private readonly scroll: ScrollBoxRenderable;
  private readonly theme: CliTheme;
  private readonly notice: TextRenderable;
  private occupant: Occupant = { kind: "empty" };
  /** Said while a panel held the slot, shown when the panel gives it back. */
  private queued: { lines: readonly string[]; color: string | undefined } | undefined;
  private rows = 0;

  constructor(
    renderer: CliRenderer,
    scroll: ScrollBoxRenderable,
    theme: CliTheme,
    nextId: (prefix?: string) => string,
  ) {
    this.renderer = renderer;
    this.scroll = scroll;
    this.theme = theme;
    this.container = new BoxRenderable(renderer, {
      id: "ephemeral",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      visible: false,
      height: 0,
    });
    this.notice = new TextRenderable(renderer, {
      id: nextId("notice"),
      content: "",
      visible: false,
      wrapMode: "none",
      // Same rail as the composer's prompt glyph.
      marginLeft: 3,
      marginRight: 2,
    });
    this.container.add(this.notice);
  }

  /** True while a panel or a notice is holding rows. */
  get showing(): boolean {
    return this.occupant.kind !== "empty";
  }

  /**
   * Client status, in the one place the record cannot keep it. It replaces
   * whatever text the slot was showing, and the next keypress clears it.
   */
  say(text: string | readonly string[], color?: string): void {
    const lines = (typeof text === "string" ? [text] : text).flatMap((line) => line.split("\n"));
    if (lines.length === 0) {
      this.clear();
      return;
    }
    // A panel owns focus and a key listener, so text may not evict it. Little
    // reaches here, because the shell closes a menu before reporting what the
    // menu did. What does arrive waits its turn instead of vanishing or
    // pulling the panel out from under the keyboard.
    if (this.occupant.kind === "panel") {
      this.queued = { lines, color };
      return;
    }
    this.occupant = { kind: "notice", lines, color };
    this.paintNotice();
  }

  /**
   * Hand the slot to a panel and take the rows it asks for. Calling it again
   * for the same panel re-takes the rows, which is what a filtered menu does
   * on every keystroke.
   */
  mount(container: BoxRenderable, rows: number): void {
    if (this.occupant.kind !== "panel" || this.occupant.container !== container) {
      this.detachPanel();
      this.notice.visible = false;
      this.occupant = { kind: "panel", container };
      this.container.add(container);
    }
    this.take(rows);
  }

  /** The mounted panel's row count changed; nothing else may call this. */
  setRows(rows: number): void {
    if (this.occupant.kind !== "panel") return;
    this.take(rows);
  }

  /**
   * Give the slot back, but only if `owner` still holds it. A dropdown that a
   * menu displaced closes itself afterwards, and that close must not tear
   * down the menu that took its place. The same guard stops the next keypress
   * dismissing a panel when it means to dismiss a notice.
   */
  release(owner: BoxRenderable | "notice"): void {
    const held =
      owner === "notice"
        ? this.occupant.kind === "notice"
        : this.occupant.kind === "panel" && this.occupant.container === owner;
    if (held) this.clear();
  }

  /** Gives every borrowed row back. Safe to call when the slot is empty. */
  clear(): void {
    if (this.occupant.kind === "empty" && this.queued === undefined) return;
    this.detachPanel();
    this.notice.visible = false;
    this.occupant = { kind: "empty" };
    this.take(0);
    const waiting = this.queued;
    if (waiting === undefined) return;
    this.queued = undefined;
    this.say(waiting.lines, waiting.color);
  }

  /** A shorter terminal fits fewer notice rows, so the cap is re-taken. */
  resize(): void {
    if (this.occupant.kind === "notice") this.paintNotice();
  }

  /** Repaint an uncolored notice after the shared theme object changes. */
  retheme(): void {
    if (this.occupant.kind === "notice" && this.occupant.color === undefined) this.paintNotice();
  }

  private detachPanel(): void {
    if (this.occupant.kind !== "panel") return;
    const { container } = this.occupant;
    if (container.parent === this.container) this.container.remove(container);
  }

  private paintNotice(): void {
    if (this.occupant.kind !== "notice") return;
    const { lines, color } = this.occupant;
    const limit = noticeRowLimit(this.renderer.height);
    const shown = lines.length <= limit ? lines : lines.slice(0, limit);
    this.notice.content = new StyledText([fg(color ?? this.theme.dim)(shown.join("\n"))]);
    this.notice.height = shown.length;
    this.notice.visible = true;
    this.take(shown.length);
  }

  /**
   * The one place the borrow happens. The slot becomes as tall as it asked to
   * be, and the same count comes off the transcript's bottom margin, so the
   * column still adds up and the viewport never changes.
   */
  private take(rows: number): void {
    const next = Math.max(0, Math.floor(rows));
    if (next === this.rows) return;
    this.rows = next;
    this.container.height = next;
    this.container.visible = next > 0;
    this.scroll.marginBottom = -next;
    this.renderer.requestRender();
  }
}
