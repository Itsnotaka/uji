import { BoxRenderable, CliRenderEvents, TextRenderable } from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { fileMentionSuggestions } from "./composer.ts";
import type { MentionFile } from "./composer.ts";
import { directoryCompletionQuery } from "./directory-autocomplete.ts";
import type { DirectoryCompletionQuery, DirectorySuggestion } from "./directory-autocomplete.ts";
import { MenuList } from "./menu-list.ts";
import type { MenuItem } from "./menu-list.ts";
import {
  acceptSlashCommand,
  slashCommandLabel,
  slashSuggestions,
  SLASH_COMMANDS,
} from "./slash.ts";
import type { SlashCommand } from "./slash.ts";
import type { CliTheme } from "./theme.ts";

interface SlashInput {
  readonly plainText: string;
  clear: () => void;
  focus: () => void;
  gotoBufferEnd: () => boolean;
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
}

type AutocompleteSuggestion =
  | { kind: "command"; command: SlashCommand }
  | { kind: "directory"; directory: DirectorySuggestion }
  | { kind: "file"; file: MentionFile };

const MAX_ROWS = 10;
// Composer, powerline, dropdown padding, and the global hint row occupy six
// terminal rows even when the transcript yields all remaining space.
const CHROME_ROWS = 6;
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
 * Inline slash, directory, and file completion. The background fills the full
 * row instead of leaving a one-cell moat around it, matching Grok Build's
 * borderless list.
 *
 * Based on Grok Build's dropdown chrome and slash dropdown:
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs
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
  private commandSignature = commandsSignature(SLASH_COMMANDS);
  private files: readonly MentionFile[] = [];
  private suggestions: readonly AutocompleteSuggestion[] = [];
  private mentionStart = 0;
  private hasMatches = false;
  private value: string | undefined;
  private directoryGeneration = 0;
  private dismissed = false;

  constructor(options: SlashAutocompleteOptions) {
    this.renderer = options.renderer;
    this.input = options.input;
    this.onCommand = options.onCommand;
    this.onFile = options.onFile;
    this.completeDirectories = options.completeDirectories;
    this.container = new BoxRenderable(options.renderer, {
      id: options.nextId("slash-menu"),
      visible: false,
      flexShrink: 0,
      flexDirection: "column",
      // No panel fill: the dropdown is part of the composer, not a window
      // over it. Only the selected row takes a background.
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

  update(
    value: string,
    commands: readonly SlashCommand[] = SLASH_COMMANDS,
    files: readonly MentionFile[] = EMPTY_MENTION_FILES,
  ): void {
    const signature = commandsSignature(commands);
    if (value === this.value && signature === this.commandSignature && files === this.files) return;
    this.value = value;
    this.commandSignature = signature;
    this.files = files;
    const generation = ++this.directoryGeneration;

    const slash = slashSuggestions(value, commands);
    if (slash !== undefined) {
      if (this.dismissed) return;
      this.suggestions = slash.map((command) => ({ kind: "command", command }));
      this.renderSuggestions("no matching commands");
      return;
    }

    const directory = directoryCompletionQuery(value);
    if (directory !== undefined) {
      if (this.dismissed) return;
      this.suggestions = [];
      this.renderSuggestions("Finding directories…");
      void this.loadDirectories(value, directory, generation);
      return;
    }

    const mention = fileMentionSuggestions(value, files);
    if (mention === undefined) {
      this.close();
      return;
    }
    if (this.dismissed) return;
    this.mentionStart = mention.query.start;
    this.suggestions = mention.files.map((file) => ({ kind: "file", file }));
    this.renderSuggestions("no matching files");
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.visible) return false;

    if (key.name === "escape") {
      this.dismiss();
      return this.consume(key);
    }
    if (key.name !== "return" && key.name !== "tab") {
      return this.list.handleNavigationKey(key) ? this.consume(key) : false;
    }

    if (!this.hasMatches) return this.consume(key);
    this.run(this.suggestions[this.list.selectedIndex], key.name);
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
    if (suggestion === undefined) return;
    if (suggestion.kind === "directory") {
      this.completeInput(`/cd ${suggestion.directory.completion}`);
      return;
    }
    if (suggestion.kind === "file") {
      const marker = this.onFile(suggestion.file.path);
      this.completeInput(`${this.input.plainText.slice(0, this.mentionStart)}${marker} `);
      return;
    }
    const acceptance = acceptSlashCommand(suggestion.command, via);
    this.close();
    if (acceptance.action === "complete") {
      this.value = acceptance.text;
      this.input.setText(acceptance.text);
      this.input.gotoBufferEnd();
      this.input.focus();
      return;
    }
    this.value = "";
    this.input.clear();
    this.onCommand(suggestion.command);
  }

  private completeInput(text: string): void {
    this.close();
    this.value = text;
    this.input.setText(text);
    this.input.gotoBufferEnd();
    this.input.focus();
  }

  close(): void {
    this.directoryGeneration += 1;
    this.value = undefined;
    this.dismissed = false;
    this.container.visible = false;
  }

  private dismiss(): void {
    this.directoryGeneration += 1;
    this.dismissed = true;
    this.container.visible = false;
  }

  destroy(): void {
    this.directoryGeneration += 1;
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize);
    this.container.destroyRecursively();
  }

  private maxVisibleForHeight(height: number): number {
    return Math.max(1, Math.min(MAX_ROWS, height - CHROME_ROWS));
  }

  private readonly onResize = (_width: number, height: number): void => {
    this.list.setMaxVisible(this.maxVisibleForHeight(height));
  };

  private consume(key: KeyEvent): true {
    key.preventDefault();
    key.stopPropagation();
    return true;
  }
}
