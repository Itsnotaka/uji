/**
 * A card you dismiss, for a number that keeps changing.
 *
 * A usage snapshot belongs to the workspace now, not the conversation history.
 * Filed in the transcript it goes stale, and running `/usage` three times leaves
 * three wrong answers to scroll past. So it opens in the
 * ephemeral slot the way `/settings` opens a menu, holds the keyboard while
 * it is up, and gives the rows back on escape.
 *
 * Every line is one row and truncates instead of wrapping, so `rows` counts
 * the children it renders. Nothing reads a laid-out height, and the count
 * cannot drift from the screen. `show` swaps the card once the host's account
 * refresh lands and re-declares the count through `onRows`.
 *
 * The card carries semantic shares and tones. This file chooses bar and label
 * widths from the terminal, then maps them to glyphs and colors.
 */
import { BoxRenderable, CliRenderEvents, fg, StyledText, TextRenderable } from "@opentui/core";
import type { CliRenderer, KeyEvent, Renderable, TextChunk } from "@opentui/core";
import { GLYPHS } from "./constants.ts";
import type { CliTheme } from "./theme.ts";
import { USAGE_BAR_CELLS } from "./usage.ts";
import type { RunCardRow, Tone, UsageCard, UsageCardRow } from "./usage.ts";
import { displayWidth, padDisplay, truncateDisplay } from "./width.ts";

interface UsagePanelOptions {
  renderer: CliRenderer;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
  /** The row count changed; the shell resizes the slot it borrows. */
  onRows: (rows: number) => void;
  onClose: () => void;
}

/** The frame's rules, margins, and horizontal padding. */
const BORDER_ROWS = 2;
const CARD_CHROME_CELLS = 8;
const MIN_BAR_CELLS = 4;

const FILLED = "━";

/** An open operation nobody is driving: hollow, next to the running bullet. */
const INTERRUPTED = "○";

export class UsagePanel {
  readonly container: BoxRenderable;

  private readonly renderer: CliRenderer;
  private readonly theme: CliTheme;
  private readonly nextId: (prefix?: string) => string;
  private readonly onRows: (rows: number) => void;
  private readonly onClose: () => void;
  private card: UsageCard;
  private lines = 0;
  private closed = false;

  constructor(options: UsagePanelOptions, card: UsageCard) {
    this.renderer = options.renderer;
    this.theme = options.theme;
    this.nextId = options.nextId;
    this.onRows = options.onRows;
    this.onClose = options.onClose;
    this.card = card;

    this.container = new BoxRenderable(this.renderer, {
      id: this.nextId("usage-card"),
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: this.theme.promptBorder,
      paddingLeft: 2,
      paddingRight: 2,
      marginLeft: 1,
      marginRight: 1,
      backgroundColor: this.theme.transparent,
    });
    this.show(card);
    this.renderer.keyInput.on("keypress", this.onKeyPress);
    this.renderer.on(CliRenderEvents.RESIZE, this.onResize);
  }

  /** Declared, not measured: the ephemeral slot borrows exactly this many. */
  get rows(): number {
    return this.lines + BORDER_ROWS;
  }

  get hints(): string {
    return "esc close";
  }

  get destroyed(): boolean {
    return this.closed;
  }

  /** Replace the card, keeping the frame. The slot is told the new count. */
  show(card: UsageCard): void {
    if (this.closed) return;
    this.card = card;
    this.rebuild(this.renderer.width);
  }

  /** Nothing to type into, so focus is only about who owns escape. */
  focus(): void {}

  blur(): void {}

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize);
    this.container.parent?.remove(this.container);
    this.container.destroyRecursively();
  }

  private readonly onKeyPress = (key: KeyEvent): void => {
    if (this.closed || key.defaultPrevented) return;
    if (key.name !== "escape" && key.name !== "return") return;
    key.preventDefault();
    key.stopPropagation();
    this.onClose();
  };

  private readonly onResize = (width: number): void => {
    if (!this.closed) this.rebuild(width);
  };

  private rebuild(width: number): void {
    for (const child of this.container.getChildren()) {
      this.container.remove(child);
      child.destroyRecursively();
    }
    const children = this.build(this.card, width);
    for (const child of children) this.container.add(child);
    this.lines = children.length;
    this.onRows(this.rows);
    this.renderer.requestRender();
  }

  private tone(tone: Tone): string {
    const { theme } = this;
    return tone === "critical" ? theme.error : tone === "warning" ? theme.warning : theme.accent;
  }

  private barChunks(share: number, cells: number, color: string): TextChunk[] {
    const { theme } = this;
    const fill = share <= 0 ? 0 : Math.max(1, Math.min(cells, Math.round(share * cells)));
    return [
      ...(fill > 0 ? [fg(color)(FILLED.repeat(fill))] : []),
      ...(fill < cells ? [fg(theme.muted)(GLYPHS.rule.repeat(cells - fill))] : []),
    ];
  }

  private row(content: string | StyledText): TextRenderable {
    const { theme } = this;
    return new TextRenderable(this.renderer, {
      id: this.nextId("usage-row"),
      content,
      height: 1,
      wrapMode: "none",
      selectionBg: theme.selectionBackground,
      selectionFg: theme.selectionForeground,
    });
  }

  private splitRow(
    left: string,
    right: string,
    tones: { left?: string; right?: string } = {},
  ): BoxRenderable {
    const { theme } = this;
    const container = new BoxRenderable(this.renderer, {
      id: this.nextId("usage-heading"),
      flexDirection: "row",
      justifyContent: "space-between",
      width: "100%",
      height: 1,
    });
    container.add(
      new TextRenderable(this.renderer, {
        id: this.nextId("usage-title"),
        content: left,
        fg: tones.left ?? theme.dim,
        flexShrink: 0,
        wrapMode: "none",
      }),
    );
    container.add(
      new TextRenderable(this.renderer, {
        id: this.nextId("usage-total"),
        content: right,
        fg: tones.right ?? theme.dim,
        flexShrink: 1,
        minWidth: 1,
        wrapMode: "none",
      }),
    );
    return container;
  }

  private runRow(run: RunCardRow, columns: number): BoxRenderable {
    const { theme } = this;
    const live = run.state === "live";
    const reserved = 2 + 2 + displayWidth(run.detail) + 2 + displayWidth(run.usage);
    const label = truncateDisplay(run.label, Math.max(1, columns - reserved), GLYPHS.ellipsis);
    const container = new BoxRenderable(this.renderer, {
      id: this.nextId("usage-run"),
      flexDirection: "row",
      width: "100%",
      height: 1,
    });
    container.add(
      new TextRenderable(this.renderer, {
        id: this.nextId("usage-run-state"),
        content: `${live ? GLYPHS.bullet : INTERRUPTED} `,
        fg: live ? theme.running : theme.dim,
        width: 2,
        flexShrink: 0,
        wrapMode: "none",
      }),
    );
    container.add(
      new TextRenderable(this.renderer, {
        id: this.nextId("usage-run-label"),
        content: label,
        fg: live ? theme.foreground : theme.dim,
        flexGrow: 1,
        flexBasis: 0,
        minWidth: 1,
        wrapMode: "none",
      }),
    );
    container.add(
      new TextRenderable(this.renderer, {
        id: this.nextId("usage-run-detail"),
        content: `  ${run.detail}`,
        fg: theme.dim,
        flexShrink: 1,
        minWidth: 1,
        wrapMode: "none",
      }),
    );
    container.add(
      new TextRenderable(this.renderer, {
        id: this.nextId("usage-run-usage"),
        content: `  ${run.usage}`,
        fg: live ? theme.foreground : theme.dim,
        flexShrink: 0,
        wrapMode: "none",
      }),
    );
    return container;
  }

  private workspaceLayout(
    rows: readonly UsageCardRow[],
    columns: number,
  ): { labelCells: number; barCells: number } {
    const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
    const costWidth = Math.max(...rows.map((row) => displayWidth(row.cost)));
    const tokenWidth = Math.max(...rows.map((row) => displayWidth(row.tokens)));
    const available = columns - 6 - costWidth - tokenWidth;
    const labelCells = Math.min(labelWidth, Math.max(MIN_BAR_CELLS, available - MIN_BAR_CELLS));
    const barCells = Math.max(MIN_BAR_CELLS, Math.min(USAGE_BAR_CELLS, available - labelCells));
    return { labelCells, barCells };
  }

  /** One list, rendered and counted, so `rows` cannot drift from the screen. */
  private build(card: UsageCard, width: number): Renderable[] {
    const { theme } = this;
    const columns = Math.max(1, width - CARD_CHROME_CELLS);
    const children: Renderable[] = [
      this.splitRow("usage", "", { left: theme.foreground }),
      this.row(""),
    ];

    if (card.runs.kind === "none") {
      children.push(this.splitRow("in progress", "none", { left: theme.foreground }));
    } else {
      children.push(this.splitRow("in progress", card.runs.summary, { left: theme.foreground }));
      for (const run of card.runs.rows) children.push(this.runRow(run, columns));
      if (card.runs.more !== undefined) {
        children.push(this.row(new StyledText([fg(theme.dim)(`  ${card.runs.more}`)])));
      }
      children.push(this.row(new StyledText([fg(theme.dim)(card.runs.note)])));
    }

    children.push(this.row(""));
    if (card.headroom.kind === "none") {
      children.push(this.splitRow("account headroom", "not in use", { left: theme.foreground }));
    } else {
      children.push(
        this.splitRow("account headroom", card.headroom.summary, { left: theme.foreground }),
      );
      for (const account of card.headroom.rows) {
        const metaTone = account.kind === "known" && account.stale ? theme.warning : theme.dim;
        children.push(
          this.splitRow(account.name, account.meta, { left: theme.foreground, right: metaTone }),
        );
        if (account.kind === "unknown") continue;
        for (const window of account.windows) {
          const color = this.tone(window.tone);
          const fixed =
            displayWidth(`  ${window.label}`) +
            2 +
            displayWidth(window.remaining) +
            2 +
            displayWidth(window.reset);
          const cells = Math.max(MIN_BAR_CELLS, Math.min(USAGE_BAR_CELLS, columns - fixed));
          children.push(
            this.row(
              new StyledText([
                fg(theme.dim)(`  ${window.label}`),
                ...this.barChunks(window.share, cells, color),
                fg(color)(`  ${window.remaining}`),
                fg(theme.dim)(`  ${window.reset}`),
              ]),
            ),
          );
        }
      }
    }

    children.push(this.row(""));
    if (card.workspace.kind === "empty") {
      children.push(
        this.splitRow(card.workspace.title, "", { left: theme.foreground }),
        this.row(new StyledText([fg(theme.dim)(card.workspace.message)])),
      );
    } else {
      children.push(
        this.splitRow(card.workspace.title, card.workspace.total, {
          left: theme.foreground,
          right: theme.number,
        }),
      );
      const layout = this.workspaceLayout(card.workspace.rows, columns);
      for (const entry of card.workspace.rows) {
        const tone = entry.system ? theme.dim : theme.foreground;
        const label = padDisplay(
          truncateDisplay(entry.label, layout.labelCells, GLYPHS.ellipsis),
          layout.labelCells,
        );
        children.push(
          this.row(
            new StyledText([
              fg(tone)(`${label}  `),
              ...this.barChunks(entry.share, layout.barCells, theme.accent),
              fg(tone)(`  ${entry.cost}`),
              fg(theme.dim)(`  ${entry.tokens}`),
            ]),
          ),
        );
      }
      for (const line of card.workspace.breakdown) {
        children.push(this.row(new StyledText([fg(theme.dim)(line)])));
      }
      if (card.workspace.thisChat !== undefined) {
        children.push(this.row(new StyledText([fg(theme.dim)(card.workspace.thisChat)])));
      }
      children.push(
        this.row(new StyledText([fg(theme.dim)("estimates exclude subscription billing")])),
      );
    }
    return children;
  }
}
