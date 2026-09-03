import { BoxRenderable, CliRenderEvents, TextRenderable } from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { fileMentionSuggestions } from "./composer.ts";
import type { MentionFile } from "./composer.ts";
import { directoryCompletionQuery } from "./directory-autocomplete.ts";
import type { DirectoryCompletionQuery, DirectorySuggestion } from "./directory-autocomplete.ts";
import { MenuList } from "./menu-list.ts";
import type { MenuItem } from "./menu-list.ts";
import { acceptSlashCommand, slashCommandLabel, slashCompletion, SLASH_COMMANDS } from "./slash.ts";
import type { SlashCommand } from "./slash.ts";
import type { CliTheme } from "./theme.ts";
import { cellIndex, cellOffset } from "./width.ts";

interface SlashInput {
  readonly plainText: string;
  cursorOffset: number;
  clear: () => void;
  focus: () => void;
  setText: (text: string) => void;
}

interface SlashAutocompleteOptions {
  renderer: CliRenderer;
  input: SlashInput;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
  onCommand: (command: SlashCommand) => void;
  onFile: (path: string) => string;
  completeDirectories: (query: DirectoryCompletionQuery) => Promise<readonly DirectorySuggestion[]>;
  /**
   * The dropdown's row count as it opens, filters, and closes. Zero means it
   * is hidden. The shell borrows exactly this many rows from the transcript,
   * so the number has to arrive with the change, not a layout pass later.
   */
  onRows: (rows: number) => void;
}

type AutocompleteSuggestion =
  | { kind: "command"; command: SlashCommand; leading: boolean }
  | { kind: "directory"; directory: DirectorySuggestion }
  | { kind: "file"; file: MentionFile };

/** The buffer span an accepted suggestion replaces: the token it completes. */
interface TokenSpan {
  start: number;
  end: number;
}

const MAX_ROWS = 10;
// Composer, powerline, dropdown padding, and the global hint row occupy six
// terminal rows even when the transcript yields all remaining space.
const CHROME_ROWS = 6;
/** The dropdown's own rows: padding above and below the list. */
const PANEL_CHROME_ROWS = 2;
/**
 * The composer spends a border column and a padding column on each side, so
 * matching its inner span means two columns on the left, under the prompt
 * glyph, and one on the right.
 */
const PADDING_LEFT = 2;
const PADDING_RIGHT = 1;
const EMPTY_MENTION_FILES: readonly MentionFile[] = [];

function commandsSignature(commands: readonly SlashCommand[]): string {
  return commands.map((command) => `${command.name}\0${command.description}`).join("\0");
}

/**
 * The keycaps that pick the highlighted row, and only when nothing is held
 * with them. The dropdown answers keys from a global listener, which runs
 * before the focused composer, so anything it claims is a key the composer
 * never sees: shift+enter and option+enter would stop opening a new line, and
 * ctrl+enter would stop queueing. A held modifier means the keystroke was
 * always meant for the composer, whatever happens to be dropped down over it.
 */
function acceptedVia(key: KeyEvent): "return" | "tab" | undefined {
  if (key.ctrl || key.meta || key.shift || key.option === true || key.super === true) {
    return undefined;
  }
  if (key.name === "return" || key.name === "kpenter") return "return";
  return key.name === "tab" ? "tab" : undefined;
}

/**
 * Inline slash, directory, and file completion. The background fills the full
 * row instead of leaving a one-cell moat around the borderless list.
 *
 * It mounts in the ephemeral slot, which is why it reports its rows.
 *
 * Based on https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs
 */
export class SlashAutocomplete {
  readonly container: BoxRenderable;

  private readonly renderer: CliRenderer;
  private readonly input: SlashInput;
  private readonly list: MenuList;
  private readonly empty: TextRenderable;
  private readonly onCommand: (command: SlashCommand) => void;
  private readonly onFile: (path: string) => string;
  private readonly completeDirectories: SlashAutocompleteOptions["completeDirectories"];
  private readonly onRows: (rows: number) => void;
  private commandSignature = commandsSignature(SLASH_COMMANDS);
  private files: readonly MentionFile[] = [];
  private cwd: string | undefined;
  private suggestions: readonly AutocompleteSuggestion[] = [];
  private span: TokenSpan | undefined;
  private hasMatches = false;
  private value: string | undefined;
  private cursor = 0;
  private directoryGeneration = 0;
  private dismissed = false;

  constructor(options: SlashAutocompleteOptions) {
    this.renderer = options.renderer;
    this.input = options.input;
    this.onCommand = options.onCommand;
    this.onFile = options.onFile;
    this.completeDirectories = options.completeDirectories;
    this.onRows = options.onRows;
    this.container = new BoxRenderable(options.renderer, {
      id: options.nextId("slash-menu"),
      visible: false,
      flexShrink: 0,
      flexDirection: "column",
      // The ephemeral slot paints the opaque fill; only the selected row adds
      // a background of its own.
      backgroundColor: options.theme.transparent,
      // Same rail as the composer it drops out of, and the same inner inset,
      // so a row's first column sits under the prompt glyph.
      marginLeft: 1,
      marginRight: 1,
      paddingLeft: PADDING_LEFT,
      paddingRight: PADDING_RIGHT,
      paddingTop: 1,
      paddingBottom: 1,
    });
    this.list = new MenuList({
      renderer: options.renderer,
      theme: options.theme,
      nextId: options.nextId,
      background: options.theme.transparent,
      maxVisible: this.maxVisibleForHeight(options.renderer.height),
      onSelect: (_item, index) => this.run(this.suggestions[index], "return"),
    });
    this.empty = new TextRenderable(options.renderer, {
      id: options.nextId("slash-empty"),
      content: "no matching commands",
      fg: options.theme.dim,
      visible: false,
    });
    this.container.add(this.list.container);
    this.container.add(this.empty);
    this.renderer.on(CliRenderEvents.RESIZE, this.onResize);
  }

  get visible(): boolean {
    return this.container.visible;
  }

  /**
   * Whether the dropdown would take Enter or Tab. An open menu with nothing in
   * it is a note, not a choice, so the composer keeps its keys and a draft that
   * merely looks like a path — `/etc/hosts` — still submits.
   */
  get accepting(): boolean {
    return this.visible && this.hasMatches;
  }

  /**
   * Rows the dropdown needs right now, zero while it is hidden. Declared
   * rather than measured, so the slot resizes in the same tick the list does.
   */
  get rows(): number {
    if (!this.container.visible) return 0;
    return (
      PANEL_CHROME_ROWS +
      Math.max(1, Math.min(this.suggestions.length, this.maxVisibleForHeight(this.renderer.height)))
    );
  }

  /** Repaint the persistent dropdown after the shared theme object changes. */
  retheme(theme: CliTheme): void {
    this.container.backgroundColor = theme.transparent;
    this.list.retheme(theme, theme.transparent);
    this.empty.fg = theme.dim;
  }

  /**
   * `cursor` is the composer's cell offset; completion follows it rather than
   * the end of the buffer, so a mention or a skill can be fixed in place.
   */
  update(
    value: string,
    commands: readonly SlashCommand[] = SLASH_COMMANDS,
    files: readonly MentionFile[] = EMPTY_MENTION_FILES,
    cwd?: string,
    cursor?: number,
  ): void {
    const index = cursor === undefined ? value.length : cellIndex(value, cursor);
    const signature = commandsSignature(commands);
    if (
      value === this.value &&
      index === this.cursor &&
      signature === this.commandSignature &&
      files === this.files &&
      cwd === this.cwd
    ) {
      return;
    }
    this.value = value;
    this.cursor = index;
    this.commandSignature = signature;
    this.files = files;
    this.cwd = cwd;
    const generation = ++this.directoryGeneration;

    // `/cd` completes a path that carries its own separators, so it is read
    // from the whole line before the trigger rules get a say.
    const directory = index === value.length ? directoryCompletionQuery(value) : undefined;
    if (directory !== undefined) {
      if (this.dismissed) return;
      this.span = { start: 0, end: value.length };
      this.suggestions = [];
      this.renderSuggestions("Finding directories…");
      void this.loadDirectories(value, directory, generation);
      return;
    }

    const slash = slashCompletion(value, commands, index);
    if (slash !== undefined) {
      if (this.dismissed) return;
      // Mid-prompt, an empty menu is just a path or a fraction being typed.
      if (!slash.leading && slash.commands.length === 0) {
        this.close();
        return;
      }
      this.span = { start: slash.start, end: slash.end };
      this.suggestions = slash.commands.map((command) => ({
        kind: "command",
        command,
        leading: slash.leading,
      }));
      // Only a leading token reaches the empty state; inline ones closed above.
      this.renderSuggestions("no matching commands");
      return;
    }

    const mention = fileMentionSuggestions(value, files, cwd, index);
    if (mention === undefined) {
      this.close();
      return;
    }
    if (this.dismissed) return;
    this.span = { start: mention.query.start, end: mention.query.end };
    this.suggestions = mention.files.map((file) => ({ kind: "file", file }));
    this.renderSuggestions("no matching files or folders");
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.visible) return false;

    if (key.name === "escape") {
      this.dismiss();
      return this.consume(key);
    }
    // Navigation gets first refusal on everything else, which is what leaves
    // shift+tab walking the list back up instead of accepting a row.
    const via = acceptedVia(key);
    if (via === undefined) {
      return this.list.handleNavigationKey(key) ? this.consume(key) : false;
    }

    if (!this.hasMatches) return false;
    this.run(this.suggestions[this.list.selectedIndex], via);
    return this.consume(key);
  }

  private async loadDirectories(
    value: string,
    query: DirectoryCompletionQuery,
    generation: number,
  ): Promise<void> {
    let directories: readonly DirectorySuggestion[];
    try {
      directories = await this.completeDirectories(query);
    } catch {
      directories = [];
    }
    if (generation !== this.directoryGeneration || value !== this.value) return;
    this.suggestions = directories.map((directory) => ({ kind: "directory", directory }));
    this.renderSuggestions("no matching directories");
    this.renderer.requestRender();
  }

  private renderSuggestions(emptyContent: string): void {
    this.hasMatches = this.suggestions.length > 0;
    this.list.setItems(
      this.suggestions.map((suggestion, index) => this.menuItem(suggestion, index)),
    );
    this.empty.content = emptyContent;
    this.list.container.visible = this.hasMatches;
    this.empty.visible = !this.hasMatches;
    this.container.visible = true;
    this.onRows(this.rows);
  }

  private menuItem(suggestion: AutocompleteSuggestion, index: number): MenuItem {
    switch (suggestion.kind) {
      case "command":
        return {
          id: `command:${String(index)}`,
          label: slashCommandLabel(suggestion.command),
          description: suggestion.command.description,
        };
      case "directory":
        return {
          id: `directory:${String(index)}`,
          label: suggestion.directory.completion,
        };
      case "file":
        return {
          id: `file:${String(index)}`,
          label: suggestion.file.label,
          description: suggestion.file.displayPath,
        };
      default: {
        const _exhaustive: never = suggestion;
        return _exhaustive;
      }
    }
  }

  private run(suggestion: AutocompleteSuggestion | undefined, via: "return" | "tab"): void {
    const span = this.span;
    if (suggestion === undefined || span === undefined) return;
    if (suggestion.kind === "directory") {
      this.splice(span, `/cd ${suggestion.directory.completion}`);
      return;
    }
    if (suggestion.kind === "file") {
      this.splice(span, `${this.onFile(suggestion.file.path)} `);
      return;
    }
    const acceptance = acceptSlashCommand(
      suggestion.command,
      via,
      suggestion.leading ? this.input.plainText.slice(span.end).trim() : "",
    );
    if (acceptance.action === "complete") {
      this.splice(span, acceptance.token);
      return;
    }
    if (!suggestion.leading) {
      this.removeInlineToken(span);
      this.onCommand(suggestion.command);
      return;
    }
    this.close();
    this.value = "";
    this.cursor = 0;
    this.input.clear();
    this.onCommand(suggestion.command);
  }

  /** Remove an inline action and one redundant horizontal separator. */
  private removeInlineToken(span: TokenSpan): void {
    const value = this.input.plainText;
    if (/^[ \t]$/.test(value[span.end] ?? "")) {
      this.splice({ start: span.start, end: span.end + 1 }, "");
      return;
    }
    if (/^[ \t]$/.test(value[span.start - 1] ?? "")) {
      this.splice({ start: span.start - 1, end: span.end }, "");
      return;
    }
    this.splice(span, "");
  }

  /** Replace the completed token, keeping whatever the draft holds around it. */
  private splice(span: TokenSpan, insert: string): void {
    const value = this.input.plainText;
    const tail = value.slice(span.end);
    // The draft already separates the token from what follows it.
    const text = insert.endsWith(" ") && /^\s/.test(tail) ? insert.slice(0, -1) : insert;
    const next = `${value.slice(0, span.start)}${text}${tail}`;
    const cursor = span.start + text.length;
    this.close();
    this.value = next;
    this.cursor = cursor;
    this.input.setText(next);
    this.input.cursorOffset = cellOffset(next, cursor);
    this.input.focus();
  }

  close(): void {
    this.directoryGeneration += 1;
    this.value = undefined;
    this.span = undefined;
    this.dismissed = false;
    this.container.visible = false;
    this.onRows(0);
  }

  private dismiss(): void {
    this.directoryGeneration += 1;
    this.dismissed = true;
    this.container.visible = false;
    this.onRows(0);
  }

  destroy(): void {
    this.directoryGeneration += 1;
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize);
    this.container.visible = false;
    // Hand the slot back before the container stops being a valid child.
    this.onRows(0);
    this.container.destroyRecursively();
  }

  private maxVisibleForHeight(height: number): number {
    return Math.max(1, Math.min(MAX_ROWS, height - CHROME_ROWS));
  }

  private readonly onResize = (_width: number, height: number): void => {
    this.list.setMaxVisible(this.maxVisibleForHeight(height));
    this.onRows(this.rows);
  };

  private consume(key: KeyEvent): true {
    key.preventDefault();
    key.stopPropagation();
    return true;
  }
}
