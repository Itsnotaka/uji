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
import type { CliRenderer, TextOptions } from "@opentui/core";
import type { Entry } from "@uji-ai/core";
import {
  fitPowerlineSegments,
  hintGroups,
  powerlineSegments,
  transcriptFromEntries,
} from "./format.ts";
import type { PowerlineSegment, PowerlineState } from "./format.ts";
import { TuiFocusController } from "./lifecycle.ts";
import { InlineMenu, PickerCancelled } from "./picker.ts";
import type { Choice, ChoiceAction, MenuScreen } from "./picker.ts";
import {
  appendNote,
  ConversationTurnBlock,
  createSubtleSyntaxStyle,
  createSyntaxStyle,
  renderItems,
} from "./transcript.ts";
import type { Transcript } from "./transcript.ts";
import type { CliTheme } from "./theme.ts";
import { COMPOSER_PLACEHOLDER, GLYPHS, IDLE_HINTS } from "./constants.ts";
import { displayWidth, truncateDisplay } from "./width.ts";
import { imagePreviewMaxHeight } from "./collapsed-tag.ts";

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
  transcript: Transcript;
  scroll: ScrollBoxRenderable;
  /** Stable input frame and its lower status rule. */
  composer: BoxRenderable;
  /** Retained rich parts and the one preview opened from them. */
  composerTagRow: BoxRenderable;
  composerPreview: BoxRenderable;
  inputBox: BoxRenderable;
  prompt: TextRenderable;
  input: TextareaRenderable;
  powerline: TextRenderable;
  focus: TuiFocusController;
  hints: HintsLine;
  /** Plain source for `ui.hints`, kept so state changes can replace it. */
  hintText: string;
  nextId: (prefix?: string) => string;
  inputMode: "chat" | "auth";
  selecting: boolean;
  /** Set by the shell so a picker can dismiss the completion dropdown. */
  closeInlineMenus?: () => void;
  authenticating: boolean;
  activeTurn?: ConversationTurnBlock;
  /**
   * Entry ids the transcript already shows, from a rebuild or from live
   * harness events. The session observer skips head moves that land here.
   */
  renderedEntries: Set<string>;
}

/** How long a flashed message holds the hint row. */
export const FLASH_MS = 2000;

/**
 * The hint row, which also carries throwaway status like "Nothing is queued".
 * The transcript is a permanent record, so a note there never leaves and three
 * taps of one key leave three dead lines. This row hands itself back instead.
 *
 * The countdown runs on the render loop's deltaTime like the spinner does, so
 * it follows the renderer's clock and stops when the renderer stops.
 */
export class HintsLine extends TextRenderable {
  private hints: StyledText;
  private remaining = 0;

  constructor(renderer: CliRenderer, options: TextOptions & { content: StyledText }) {
    super(renderer, options);
    this.hints = options.content;
  }

  set(hints: StyledText): void {
    this.hints = hints;
    this.remaining = 0;
    this.live = false;
    this.content = hints;
  }

  flash(message: StyledText): void {
    this.remaining = FLASH_MS;
    this.content = message;
    this.live = true;
  }

  protected override onUpdate(deltaTime: number): void {
    if (this.remaining <= 0) return;
    this.remaining -= deltaTime;
    if (this.remaining <= 0) this.set(this.hints);
  }
}

export function setHints(ui: Ui, text: string): void {
  ui.hintText = text;
  ui.hints.set(hintsText(text, ui.transcript.theme));
}

/** Leaves `ui.hintText` alone so a picker opening mid-flash restores the real row. */
export function flash(ui: Ui, text: string, color?: string): void {
  ui.hints.flash(new StyledText([fg(color ?? ui.transcript.theme.muted)(`  ${text}`)]));
}

/**
 * Keycaps carry the weight, what they do stays quiet, and the dots between
 * groups recede furthest. Flat dim text makes the row one unreadable smear.
 */
export function hintsText(text: string, theme: CliTheme): StyledText {
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

export function buildUi(renderer: CliRenderer, theme: CliTheme): Ui {
  let counter = 0;
  const nextId = (prefix = "n"): string => `${prefix}-${String(counter++)}`;

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
  inputBox.onMouseDown = () => input.focus();
  inputBox.add(prompt);
  inputBox.add(input);

  const composer = new BoxRenderable(renderer, {
    id: "composer",
    width: "100%",
    flexShrink: 0,
    flexDirection: "column",
  });

  // Margin 3 = the composer's margin, border, and padding, so tags and
  // previews sit on the same column as the text being composed below them.
  const composerTagRow = new BoxRenderable(renderer, {
    id: "composer-tags",
    flexDirection: "row",
    flexWrap: "wrap",
    flexShrink: 0,
    gap: 1,
    visible: false,
    marginLeft: 3,
    marginRight: 2,
  });
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

  const hints = new HintsLine(renderer, {
    id: "hints",
    content: hintsText(IDLE_HINTS, theme),
    wrapMode: "none",
    height: 1,
    // The transcript gives way when a menu opens; the hint row never does.
    flexShrink: 0,
    // Lines up with the prompt glyph inside the composer's border.
    marginLeft: 1,
    marginRight: 1,
  });

  root.add(scroll);
  composer.add(composerTagRow);
  composer.add(composerPreview);
  composer.add(inputBox);
  composer.add(powerline);
  root.add(composer);
  root.add(hints);
  renderer.root.add(root);
  const focus = new TuiFocusController(input);
  const resizeComposer = (_width: number, height: number): void => {
    input.maxHeight = composerRowsForHeight(height);
    composerPreview.maxHeight = imagePreviewMaxHeight(height);
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
    nextId,
  };
  return {
    renderer,
    root,
    transcript,
    scroll,
    composer,
    composerTagRow,
    composerPreview,
    inputBox,
    prompt,
    input,
    powerline,
    focus,
    hints,
    hintText: IDLE_HINTS,
    nextId,
    inputMode: "chat",
    selecting: false,
    authenticating: false,
    renderedEntries: new Set(),
  };
}

export function note(ui: Ui, text: string, color?: string): void {
  appendNote(ui.transcript, text, color);
}

export function turnNote(ui: Ui, text: string, color?: string): void {
  if (ui.activeTurn === undefined) note(ui, text, color);
  else ui.activeTurn.addNote(text, color);
}

export function setInputText(input: TextareaRenderable, text: string): void {
  input.setText(text);
  input.gotoBufferEnd();
}

export function replaceTranscript(
  ui: Ui,
  entries: readonly Entry[],
  options: { openLastTurn?: boolean } = {},
): void {
  ui.activeTurn = undefined;
  for (const child of ui.scroll.getChildren()) {
    ui.scroll.remove(child);
    child.destroyRecursively();
  }
  ui.activeTurn = renderItems(ui.transcript, transcriptFromEntries(entries), options);
  ui.renderedEntries = new Set(entries.map((entry) => entry.id));
  ui.scroll.scrollTo({ x: 0, y: ui.scroll.scrollHeight });
}

/**
 * Drops a menu into the completion dropdown's slot: the composer stays put and
 * the list grows downward out of it.
 */
export function openInlineMenu(
  ui: Ui,
  screen: MenuScreen,
  onError?: (error: unknown) => void,
): InlineMenu {
  const menu = new InlineMenu(
    {
      renderer: ui.renderer,
      theme: ui.transcript.theme,
      nextId: ui.nextId,
      ...(onError === undefined ? {} : { onError }),
    },
    screen,
  );
  ui.closeInlineMenus?.();
  ui.root.insertBefore(menu.container, ui.hints);
  setHints(ui, menu.hints);
  ui.selecting = true;
  ui.focus.use(menu);
  return menu;
}

/** Swaps the screen an open menu shows and keeps the hint row in step. */
export function showMenuScreen(ui: Ui, menu: InlineMenu, screen: MenuScreen): void {
  menu.show(screen);
  setHints(ui, menu.hints);
  ui.renderer.requestRender();
}

/** Tears a menu down and hands the composer back its keyboard. Callers own the hint row. */
export function closeInlineMenu(ui: Ui, menu: InlineMenu): void {
  menu.destroy();
  ui.selecting = false;
  ui.focus.reset();
  ui.renderer.requestRender();
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
    /** Slow source for the same list, applied once it arrives. */
    load?: () => Promise<readonly Choice[]>;
  } = {},
): Promise<string> {
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
  private readonly state: PowerlineState;

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

  set(patch: Partial<PowerlineState>): void {
    Object.assign(this.state, patch);
    this.repaint();
  }

  get queued(): number {
    return this.state.queued;
  }

  readonly repaint = (): void => {
    const width = this.line.width > 0 ? this.line.width : Math.max(0, this.renderer.width - 2);
    const { theme } = this;
    this.line.content = framedPowerline(
      this.state,
      width,
      theme,
      this.isFocused() ? theme.promptBorderFocused : theme.promptBorder,
    );
  };
}
