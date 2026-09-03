import {
  BoxRenderable,
  CliRenderEvents,
  fg,
  MacOSScrollAccel,
  RenderableEvents,
  ScrollBoxRenderable,
  StyledText,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import { EMPTY_TRANSCRIPT, appendTranscriptEntry } from "@uji-ai/core";
import type { TranscriptState, Turn } from "@uji-ai/core";
import type { UserMessage } from "@uji-ai/schema";
import { fitPowerlineSegments, hintGroups, powerlineSegments } from "./format.ts";
import type { PowerlineSegment, PowerlineState } from "./format.ts";
import { TuiFocusController } from "./lifecycle.ts";
import { InlineMenu, PickerCancelled } from "./picker.ts";
import type { Choice, ChoiceAction, MenuScreen } from "./picker.ts";
import {
  appendMarkerItem,
  ConversationTurnBlock,
  createSubtleSyntaxStyle,
  createSyntaxStyle,
  renderItems,
  ToolOutputExpansion,
} from "./transcript.ts";
import { Ephemeral } from "./ephemeral.ts";
import type { EphemeralPanel } from "./ephemeral.ts";
import { PendingGutter } from "./pending-gutter.ts";
import { UsagePanel } from "./usage-panel.ts";
import type { UsageCard } from "./usage.ts";
import type { Transcript } from "./transcript.ts";
import { createActiveTheme, updateActiveTheme } from "./theme.ts";
import type { CliTheme } from "./theme.ts";
import { COMPOSER_PLACEHOLDER, GLYPHS, IDLE_HINTS } from "./constants.ts";
import { displayWidth, truncateDisplay } from "./width.ts";
import { imagePreviewMaxHeight } from "./collapsed-tag.ts";
import { composerMarkerSyntaxStyle } from "./composer-markers.ts";
import { bindSemantics, readSemantics } from "./semantics.ts";
import type { Entry } from "@uji-ai/core/store";

const MAX_COMPOSER_ROWS = 8;
// Preserve a transcript row, the composer's top border, the powerline, and
// the global hints before giving the remaining height to the textarea.
const COMPOSER_CHROME_ROWS = 4;

function composerRowsForHeight(height: number): number {
  return Math.max(1, Math.min(MAX_COMPOSER_ROWS, height - COMPOSER_CHROME_ROWS));
}

export interface Ui {
  renderer: CliRenderer;
  root: BoxRenderable;
  /** Stable palette object shared by every long-lived component. */
  themeState: ReturnType<typeof createActiveTheme>;
  transcript: Transcript;
  scroll: ScrollBoxRenderable;
  /** Opaque column under the transcript, including the composer and menus. */
  live: BoxRenderable;
  /** Stable input frame and its lower status rule. */
  composer: BoxRenderable;
  /** The one preview opened by clicking an inline marker pill. */
  composerPreview: BoxRenderable;
  inputBox: BoxRenderable;
  prompt: TextRenderable;
  input: TextareaRenderable;
  powerline: TextRenderable;
  /** The keycap row, pinned to the last line of the terminal. */
  hints: TextRenderable;
  /** Pending steers and follow-ups, pinned between the transcript and composer. */
  pendingGutter: PendingGutter;
  /**
   * Rows under the composer that the terminal takes back: menus, completions,
   * and every line of client status. Nothing here reaches the record.
   */
  ephemeral: Ephemeral;
  focus: TuiFocusController;
  /** Plain source for `ui.hints`, kept so state changes can replace it. */
  hintText: string;
  nextId: (prefix?: string) => string;
  inputMode: "chat" | "auth";
  selecting: boolean;
  /** Set by the shell so a picker can dismiss the completion dropdown. */
  closeInlineMenus?: () => void;
  /** A read-only panel yields when a prompt or another panel needs the slot. */
  dismissInfoPanel?: () => void;
  /**
   * Set by the shell: give the message of a run that stopped before it
   * answered back to the composer. Returns false when the shell cannot take
   * it, and the turn settles as stopped instead.
   */
  retractPrompt?: () => boolean;
  authenticating: boolean;
  activeTurn?: ConversationTurnBlock;
  /** Steers and follow-ups core is still holding, drawn above the composer. */
  queue: PendingGutter;
  /**
   * Core's transcript fold of the visible branch, plus the block each turn
   * item owns. Every committed entry advances the fold, whichever of the
   * in-process harness and the durable session watcher delivers it first;
   * the fold's seq makes the second delivery a no-op.
   */
  projection: { state: TranscriptState; turns: Map<string, ConversationTurnBlock> };
}

/**
 * The keycap row says what keys do and nothing else. Status used to borrow it
 * for two seconds at a time, which cost the row its one job and could never
 * hold more than a line. That lives in the ephemeral slot now.
 */
export function setHints(ui: Ui, text: string): void {
  ui.hintText = text;
  ui.hints.content = hintsText(text, ui.transcript.theme);
}

/**
 * Keycaps carry the weight, what they do stays quiet, and the dots between
 * groups recede furthest. Flat dim text makes the row one unreadable smear.
 */
function hintsText(text: string, theme: CliTheme): StyledText {
  const chunks = [fg(theme.dim)("  ")];
  for (const [index, group] of hintGroups(text).entries()) {
    if (index > 0) chunks.push(fg(theme.muted)(" \u00b7 "));
    chunks.push(fg(theme.user)(group.key));
    if (group.label !== "") chunks.push(fg(theme.dim)(` ${group.label}`));
  }
  return new StyledText(chunks);
}

function powerlineColor(theme: CliTheme, tone: PowerlineSegment["tone"]): string {
  switch (tone) {
    case "workspace":
      return theme.path;
    case "model":
      return theme.accent;
    case "effort":
      return theme.thinking;
    case "queue":
      return theme.warning;
    case "usage":
      return theme.dim;
  }
}

/**
 * Draw the lower prompt rule and color each status segment by its role. The
 * rule closes the composer's frame, so it takes the same border color the box
 * is drawing above it — focused or not.
 */
export function framedPowerline(
  state: PowerlineState | undefined,
  width: number,
  theme: CliTheme,
  borderColor: string = theme.promptBorder,
): StyledText {
  const frameWidth = Math.max(0, Math.floor(width));
  if (frameWidth === 0) return new StyledText([]);
  if (frameWidth === 1) return new StyledText([fg(borderColor)(GLYPHS.rule)]);
  if (state === undefined || frameWidth < 6) {
    return new StyledText([
      fg(borderColor)(
        `${GLYPHS.frameBottomLeft}${GLYPHS.rule.repeat(Math.max(0, frameWidth - 2))}${GLYPHS.frameBottomRight}`,
      ),
    ]);
  }

  const captionWidth = frameWidth - 5;
  const segments = fitPowerlineSegments(powerlineSegments(state), captionWidth);
  const chunks = [fg(borderColor)(`${GLYPHS.frameBottomLeft}${GLYPHS.rule}`)];
  let captionLength = 0;
  for (const [index, segment] of segments.entries()) {
    const separator = index === 0 ? " " : ` ${GLYPHS.separator} `;
    const separatorRoom = captionWidth - captionLength;
    if (separatorRoom <= 0) break;
    const visibleSeparator = truncateDisplay(separator, separatorRoom);
    chunks.push(fg(borderColor)(visibleSeparator));
    captionLength += displayWidth(visibleSeparator);

    const textRoom = captionWidth - captionLength;
    if (textRoom <= 0) break;
    const visibleText = truncateDisplay(segment.text, textRoom);
    chunks.push(fg(powerlineColor(theme, segment.tone))(visibleText));
    captionLength += displayWidth(visibleText);
  }
  const trailingRule = GLYPHS.rule.repeat(Math.max(1, frameWidth - captionLength - 4));
  chunks.push(fg(borderColor)(` ${trailingRule}${GLYPHS.frameBottomRight}`));
  return new StyledText(chunks);
}

export function buildUi(renderer: CliRenderer, initialTheme: CliTheme): Ui {
  const theme = createActiveTheme(initialTheme);
  let counter = 0;
  const nextId = (prefix = "n"): string => `${prefix}-${String(counter++)}`;
  const userBlocks = new Set<BoxRenderable>();
  // The scroll padding and card margins consume two columns on each side.
  const userBlockWidth = (): number => Math.max(1, renderer.width - 4);

  const root = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
  });
  renderer.setBackgroundColor(theme.terminal);

  const scroll = new ScrollBoxRenderable(renderer, {
    id: "transcript",
    flexGrow: 1,
    minHeight: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    // Never scroll sideways. Without the horizontal clamp the content box
    // sizes to fit its children, and code views measure at the terminal
    // width regardless of their text, so every tool card overflowed by its
    // padding: a permanent scrollbar over columns that held nothing. Code
    // wider than the view truncates; it cannot be revealed by scrolling
    // anyway, because a code view never measures past the terminal.
    scrollX: false,
    scrollY: true,
    paddingLeft: 1,
    paddingRight: 1,
    // A breathing row between the last transcript line and the composer.
    paddingBottom: 1,
    // One row per wheel notch makes a long session feel unscrollable.
    scrollAcceleration: new MacOSScrollAccel(),
    verticalScrollbarOptions: {
      trackOptions: {
        backgroundColor: theme.scrollbarTrack,
        foregroundColor: theme.scrollbarThumb,
      },
    },
  });

  const inputBox = new BoxRenderable(renderer, {
    id: "input-box",
    flexDirection: "row",
    flexShrink: 0,
    border: ["top", "right", "left"],
    borderStyle: "rounded",
    borderColor: theme.promptBorder,
    focusedBorderColor: theme.promptBorderFocused,
    // Without this the focused border colour above never applies.
    focusable: true,
    titleColor: theme.dim,
    paddingLeft: 1,
    paddingRight: 1,
    marginLeft: 1,
    marginRight: 1,
  });
  const prompt = new TextRenderable(renderer, {
    id: "input-prompt",
    content: `${GLYPHS.prompt} `,
    fg: theme.user,
  });
  const input = new TextareaRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    maxHeight: composerRowsForHeight(renderer.height),
    wrapMode: "word",
    placeholder: COMPOSER_PLACEHOLDER,
    placeholderColor: theme.dim,
    backgroundColor: theme.transparent,
    focusedBackgroundColor: theme.transparent,
    textColor: theme.foreground,
    focusedTextColor: theme.foreground,
    cursorColor: theme.user,
    selectionBg: theme.selectionBackground,
    selectionFg: theme.selectionForeground,
    // Carries no highlighter; it exists so composer marker pills can paint.
    syntaxStyle: composerMarkerSyntaxStyle(theme),
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", shift: true, action: "newline" },
      { name: "return", meta: true, action: "newline" },
      { name: "kpenter", meta: true, action: "newline" },
      { name: "j", ctrl: true, action: "newline" },
    ],
  });
  bindSemantics(input, () => ({ role: "textbox", label: "Prompt" }));
  inputBox.onMouseDown = () => input.focus();
  inputBox.add(prompt);
  inputBox.add(input);

  const composer = new BoxRenderable(renderer, {
    id: "composer",
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
  });

  // Margin 3 = the composer's margin, border, and padding, so the preview
  // sits on the same column as the text being composed below it.
  const composerPreview = new BoxRenderable(renderer, {
    id: "composer-preview",
    flexDirection: "column",
    flexShrink: 0,
    maxHeight: imagePreviewMaxHeight(renderer.height),
    overflow: "hidden",
    visible: false,
    marginLeft: 3,
    marginRight: 2,
  });

  const powerline = new TextRenderable(renderer, {
    id: "powerline",
    content: framedPowerline(undefined, renderer.width - 2, theme),
    height: 1,
    flexShrink: 0,
    wrapMode: "none",
    selectable: false,
    marginLeft: 1,
    marginRight: 1,
  });

  const hints = new TextRenderable(renderer, {
    id: "hints",
    content: hintsText(IDLE_HINTS, theme),
    wrapMode: "none",
    height: 1,
    flexShrink: 0,
    // Lines up with the prompt glyph inside the composer's border.
    marginLeft: 1,
    marginRight: 1,
  });

  const pendingGutter = new PendingGutter(renderer, theme, nextId);
  const ephemeral = new Ephemeral(renderer, scroll, theme, nextId);

  /**
   * Everything below the transcript rides up over its tail when the ephemeral
   * slot takes rows, so this column paints opaque. Left transparent, the
   * transcript rows underneath show through the composer's frame.
   */
  const live = new BoxRenderable(renderer, {
    id: "live",
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: theme.background,
  });

  root.add(scroll);
  // Between the record and the prompt: not history, and not a draft either.
  live.add(pendingGutter.container);
  composer.add(composerPreview);
  composer.add(inputBox);
  composer.add(powerline);
  live.add(composer);
  // Menus and completions drop out of the composer, the way they are typed.
  live.add(ephemeral.container);
  live.add(hints);
  root.add(live);
  renderer.root.add(root);
  const focus = new TuiFocusController(input);
  const resizeComposer = (_width: number, height: number): void => {
    input.maxHeight = composerRowsForHeight(height);
    composerPreview.maxHeight = imagePreviewMaxHeight(height);
    for (const block of userBlocks) block.width = userBlockWidth();
    pendingGutter.resize();
    ephemeral.resize();
  };
  const blurUi = (): void => focus.blur();
  const restoreUi = (): void => focus.restore();
  renderer.on(CliRenderEvents.RESIZE, resizeComposer);
  renderer.on(CliRenderEvents.BLUR, blurUi);
  renderer.on(CliRenderEvents.FOCUS, restoreUi);
  root.once(RenderableEvents.DESTROYED, () => {
    renderer.off(CliRenderEvents.RESIZE, resizeComposer);
    renderer.off(CliRenderEvents.BLUR, blurUi);
    renderer.off(CliRenderEvents.FOCUS, restoreUi);
  });
  focus.restore();

  const transcript: Transcript = {
    renderer,
    container: scroll,
    syntaxStyle: createSyntaxStyle(theme),
    subtleSyntaxStyle: createSubtleSyntaxStyle(theme),
    theme,
    toolOutput: new ToolOutputExpansion(),
    // Settings own the real value; interactive assigns it before first draw.
    toolCalls: "auto",
    nextId,
    userLayout: { blocks: userBlocks, width: userBlockWidth },
  };
  return {
    renderer,
    root,
    themeState: theme,
    transcript,
    scroll,
    live,
    composer,
    composerPreview,
    inputBox,
    prompt,
    input,
    powerline,
    pendingGutter,
    ephemeral,
    focus,
    hints,
    hintText: IDLE_HINTS,
    nextId,
    inputMode: "chat",
    selecting: false,
    authenticating: false,
    queue: pendingGutter,
    projection: { state: EMPTY_TRANSCRIPT, turns: new Map() },
  };
}

/**
 * Repaint the shell around a new palette. The caller redraws transcript
 * entries and asks the long-lived composer controllers to refresh their
 * cached styles after this returns.
 */
export function applyUiTheme(ui: Ui, next: CliTheme): void {
  updateActiveTheme(ui.themeState, next);
  const theme = ui.themeState;

  ui.renderer.setBackgroundColor(theme.terminal);
  ui.root.backgroundColor = theme.background;
  ui.live.backgroundColor = theme.background;
  ui.scroll.verticalScrollbarOptions = {
    trackOptions: {
      backgroundColor: theme.scrollbarTrack,
      foregroundColor: theme.scrollbarThumb,
    },
  };
  ui.inputBox.borderColor = theme.promptBorder;
  ui.inputBox.focusedBorderColor = theme.promptBorderFocused;
  ui.inputBox.titleColor = theme.dim;
  ui.prompt.fg = theme.user;
  ui.input.placeholderColor = theme.dim;
  ui.input.backgroundColor = theme.transparent;
  ui.input.focusedBackgroundColor = theme.transparent;
  ui.input.textColor = theme.foreground;
  ui.input.focusedTextColor = theme.foreground;
  ui.input.cursorColor = theme.user;
  ui.input.selectionBg = theme.selectionBackground;
  ui.input.selectionFg = theme.selectionForeground;
  ui.input.syntaxStyle = composerMarkerSyntaxStyle(theme);
  ui.powerline.content = framedPowerline(undefined, ui.powerline.width, theme);
  ui.hints.content = hintsText(ui.hintText, theme);
  ui.pendingGutter.retheme();
  ui.ephemeral.retheme();
  ui.transcript.syntaxStyle = createSyntaxStyle(theme);
  ui.transcript.subtleSyntaxStyle = createSubtleSyntaxStyle(theme);
  ui.renderer.requestRender();
}

/**
 * The one way to tell the user something that is not part of the
 * conversation. It lands in the ephemeral slot under the composer and the
 * next keypress takes it back.
 *
 * There is deliberately no counterpart that writes free text into the
 * transcript. The transcript is the record and only core's log may fill it,
 * so a model switch, a login, a `/usage` table or "Nothing is queued" has
 * exactly one destination and no decision to get wrong.
 */
export function notice(ui: Ui, text: string | readonly string[], color?: string): void {
  ui.ephemeral.say(text, color);
}

/**
 * Text the run produced, such as a plugin's question, its answer, or the
 * error that ended the turn. It belongs to the turn on screen, so it goes in
 * the record beside it. With no turn open there is nothing to belong to, and
 * it is status like any other.
 */
export function turnNote(ui: Ui, text: string, color?: string): void {
  if (ui.activeTurn === undefined) notice(ui, text, color);
  else ui.activeTurn.addNote(text, color);
}

export function setInputText(input: TextareaRenderable, text: string): void {
  input.setText(text);
  input.gotoBufferEnd();
}

type TranscriptMessageDirection = "next" | "previous";

/** Jump to the next semantic turn boundary above or below the viewport. */
export function navigateTranscriptMessage(
  scroll: ScrollBoxRenderable,
  direction: TranscriptMessageDirection,
): string | undefined {
  const top = scroll.scrollTop;
  const messages = scroll.getChildren().flatMap((renderable) => {
    const semantics = readSemantics(renderable);
    if (semantics?.role !== "message" || !renderable.visible) return [];
    // A child's `y` is its screen position, which the scroll translates on
    // every move; navigation reasons in content space, which does not.
    return [{ contentY: renderable.y - scroll.y + top, semantics }];
  });
  const target =
    direction === "next"
      ? messages.find(({ contentY }) => contentY > top)
      : messages.findLast(({ contentY }) => contentY < top);
  if (target === undefined) return undefined;
  scroll.stickyScroll = false;
  scroll.scrollTo(target.contentY);
  return target.semantics.id;
}

/**
 * Rebuild the chat from a branch. Only deliberate moves land here: the
 * initial render, navigation, and a session switch. Linear commits go through
 * `commitTranscriptEntry` and never repaint what is already on screen.
 */
export function replaceTranscript(
  ui: Ui,
  entries: readonly Entry[],
  options: { openLastTurn?: boolean } = {},
): void {
  ui.activeTurn = undefined;
  ui.queue.clear();
  for (const child of ui.scroll.getChildren()) {
    ui.scroll.remove(child);
    child.destroyRecursively();
  }
  const state = entries.reduce(appendTranscriptEntry, EMPTY_TRANSCRIPT);
  const turns = new Map<string, ConversationTurnBlock>();
  ui.projection = { state, turns };
  ui.activeTurn = renderItems(ui.transcript, state.items, {
    ...options,
    register: (id, turn) => turns.set(id, turn),
  });
  ui.queue.sync(ui.queue.pending);
  // The branch changed under the viewport, so a kept offset would point at
  // rows that no longer exist. Land where the head now is.
  ui.scroll.stickyScroll = true;
  ui.scroll.scrollTo(ui.scroll.scrollHeight);
}

/**
 * The turn a user entry opens, drawn in the same dispatch the harness reports
 * it. The durable commit follows through `commitTranscriptEntry` and finds
 * this block registered, so the two paths meet in one renderable.
 */
export function openUserTurn(ui: Ui, entryId: string, content: UserMessage["content"]): void {
  const existing = ui.projection.turns.get(entryId);
  const turn = existing ?? new ConversationTurnBlock(ui.transcript, { id: entryId });
  if (existing === undefined) {
    ui.activeTurn?.settle();
    ui.projection.turns.set(entryId, turn);
  }
  ui.activeTurn = turn;
  turn.addUser(content, entryId);
}

/**
 * The block a folded turn item lands in: the one already registered for its
 * id, the live turn that opened without an id (a resumed run draws before its
 * entries commit), or a fresh one for a turn nothing local is streaming. A
 * turn item that is not the open live turn ends whatever was: core has moved
 * on, so the screen does too.
 */
function syncTurnItem(ui: Ui, item: Extract<Turn, { kind: "turn" }>): void {
  let block = ui.projection.turns.get(item.id);
  if (
    block === undefined &&
    item.parts[0]?.kind !== "user" &&
    ui.activeTurn?.claim(item.id) === true
  ) {
    block = ui.activeTurn;
  }
  block ??= new ConversationTurnBlock(ui.transcript, {
    id: item.id,
    outcome: item.outcome,
    durationMs: item.durationMs,
  });
  ui.projection.turns.set(item.id, block);
  // A settled turn stays settled: a lagging commit for a finished run updates
  // its parts without reopening it as the turn notes attach to.
  if (ui.activeTurn !== block && !block.isClosed) {
    ui.activeTurn?.settle();
    ui.activeTurn = block;
  }
  for (const part of item.parts) block.addStoredPart(part);
}

/**
 * Fold one committed entry into the chat. The fold appends or revises only
 * the tail of its items, so this updates existing renderables in place and
 * never touches earlier scrollback. A compaction is one appended marker: it
 * ends the open turn, because core opens a new one for whatever follows, and
 * the stream continuing after a mid-run compaction lands below the card.
 */
export function commitTranscriptEntry(ui: Ui, entry: Entry): void {
  const prev = ui.projection.state;
  const next = appendTranscriptEntry(prev, entry);
  if (next === prev) return;
  ui.projection.state = next;
  for (let index = Math.max(0, prev.items.length - 1); index < next.items.length; index++) {
    const item = next.items[index];
    if (item === undefined || item === prev.items[index]) continue;
    if (item.kind === "turn") {
      syncTurnItem(ui, item);
      continue;
    }
    ui.activeTurn?.settle();
    ui.activeTurn = undefined;
    appendMarkerItem(ui.transcript, item);
  }
}

/**
 * Opens a panel under the composer, which rides up over the transcript's tail
 * to make room. The chat behind it does not move, because the ephemeral slot
 * borrows those rows rather than taking them.
 *
 * Every panel takes this path, so a menu, a completion list and the `/usage`
 * card open, hold the keyboard, and close the same way.
 */
function openPanel<P extends EphemeralPanel>(ui: Ui, panel: P): P {
  ui.closeInlineMenus?.();
  ui.dismissInfoPanel?.();
  if (ui.selecting) throw new Error("Another panel is already open");
  ui.ephemeral.mount(panel.container, panel.rows);
  setHints(ui, panel.hints);
  ui.selecting = true;
  ui.focus.use(panel);
  return panel;
}

/** Tears a panel down and hands the composer back its keyboard. Callers own the hint row. */
function closePanel(ui: Ui, panel: EphemeralPanel): void {
  ui.ephemeral.release(panel.container);
  panel.destroy();
  ui.selecting = false;
  ui.focus.reset();
  ui.renderer.requestRender();
}

export function openInlineMenu(
  ui: Ui,
  screen: MenuScreen,
  onError?: (error: unknown) => void,
): InlineMenu {
  return openPanel(
    ui,
    new InlineMenu(
      {
        renderer: ui.renderer,
        theme: ui.transcript.theme,
        nextId: ui.nextId,
        onRows: (rows) => ui.ephemeral.setRows(rows),
        ...(onError === undefined ? {} : { onError }),
      },
      screen,
    ),
  );
}

/**
 * The `/usage` card, opened the way `/settings` opens a menu. Spend is a fact
 * about the workspace now, so it is shown and taken back rather than filed.
 * `panel.show(card)` swaps the card in place once the account refresh lands.
 */
export function openUsageCard(ui: Ui, card: UsageCard): UsagePanel {
  ui.closeInlineMenus?.();
  ui.dismissInfoPanel?.();
  if (ui.selecting) throw new Error("Another panel is already open");

  const restoredHints = ui.hintText;
  let panel: UsagePanel;
  const dismiss = (): void => {
    if (!panel.destroyed) {
      closePanel(ui, panel);
      setHints(ui, restoredHints);
    }
    if (ui.dismissInfoPanel === dismiss) ui.dismissInfoPanel = undefined;
  };
  panel = new UsagePanel(
    {
      renderer: ui.renderer,
      theme: ui.transcript.theme,
      nextId: ui.nextId,
      onRows: (rows) => ui.ephemeral.setRows(rows),
      onClose: dismiss,
    },
    card,
  );
  const opened = openPanel(ui, panel);
  ui.dismissInfoPanel = dismiss;
  return opened;
}

/** Swaps the screen an open menu shows and keeps the hint row in step. */
export function showMenuScreen(ui: Ui, menu: InlineMenu, screen: MenuScreen): void {
  menu.show(screen);
  setHints(ui, menu.hints);
  ui.renderer.requestRender();
}

export function closeInlineMenu(ui: Ui, menu: InlineMenu): void {
  closePanel(ui, menu);
}

/** One-shot menu: resolves with the chosen id, rejects when the user backs out. */
export function selectChoice(
  ui: Ui,
  message: string,
  choices: readonly Choice[],
  options: {
    selectedId?: string;
    maxVisible?: number;
    signal?: AbortSignal;
    onHighlight?: (id: string) => void;
    actions?: readonly ChoiceAction[];
    /** Verb on the enter keycap when picking does more than select. */
    selectLabel?: string;
    /** Slow source for the same list, applied once it arrives. */
    load?: () => Promise<readonly Choice[]>;
  } = {},
): Promise<string> {
  ui.dismissInfoPanel?.();
  if (ui.selecting) return Promise.reject(new Error("Another menu is already open"));
  if (options.signal?.aborted === true) return Promise.reject(new PickerCancelled());
  if (choices.length === 0 && options.load === undefined) {
    return Promise.reject(new Error("A selection menu needs at least 1 choice"));
  }
  const restoredHints = ui.hintText;
  let menu: InlineMenu;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      closeInlineMenu(ui, menu);
      setHints(ui, restoredHints);
      finish();
    };
    const onAbort = (): void => settle(() => reject(new PickerCancelled()));
    menu = openInlineMenu(
      ui,
      {
        title: message,
        choices,
        ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
        ...(options.maxVisible === undefined ? {} : { maxVisible: options.maxVisible }),
        ...(options.actions === undefined ? {} : { actions: options.actions }),
        ...(options.selectLabel === undefined ? {} : { selectLabel: options.selectLabel }),
        ...(options.onHighlight === undefined ? {} : { onHighlight: options.onHighlight }),
        ...(options.load === undefined ? {} : { load: options.load }),
        onSelect: (id) => settle(() => resolve(id)),
        onCancel: () => settle(() => reject(new PickerCancelled())),
      },
      (error) => settle(() => reject(error)),
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Owns the stable metadata in the composer's lower rule. */
export class ComposerStatus {
  private readonly renderer: CliRenderer;
  private readonly line: TextRenderable;
  private readonly theme: CliTheme;
  private readonly isFocused: () => boolean;
  private state: PowerlineState;
  private disposed = false;

  constructor(
    renderer: CliRenderer,
    line: TextRenderable,
    theme: CliTheme,
    isFocused: () => boolean,
    initial: PowerlineState,
  ) {
    this.renderer = renderer;
    this.line = line;
    this.theme = theme;
    this.isFocused = isFocused;
    this.state = initial;
    this.line.onSizeChange = this.repaint;
    this.repaint();
  }

  /** Update status that still belongs to the active session. */
  patch(patch: Partial<PowerlineState>): void {
    Object.assign(this.state, patch);
    this.repaint();
  }

  /** Rebuild status when the active session changes. */
  replace(state: PowerlineState): void {
    this.state = state;
    this.repaint();
  }

  get queued(): number {
    return this.state.queued;
  }

  readonly repaint = (): void => {
    // Wire callbacks resolve after teardown (a usage fetch, a queue refresh);
    // a status line without a buffer swallows them instead of throwing.
    if (this.disposed || this.line.isDestroyed) return;
    const width = this.line.width > 0 ? this.line.width : Math.max(0, this.renderer.width - 2);
    const { theme } = this;
    this.line.content = framedPowerline(
      this.state,
      width,
      theme,
      this.isFocused() ? theme.promptBorderFocused : theme.promptBorder,
    );
  };

  dispose(): void {
    this.disposed = true;
  }
}
