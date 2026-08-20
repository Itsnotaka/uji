import { BoxRenderable, InputRenderable, SelectRenderable } from "@opentui/core";
import type { CliRenderer, KeyEvent, SelectOption } from "@opentui/core";
import { resolveSlashCommand, slashQuery, slashSuggestions } from "./slash.ts";
import type { SlashCommand } from "./slash.ts";
import type { CliTheme } from "./theme.ts";

interface SlashAutocompleteOptions {
  renderer: CliRenderer;
  input: InputRenderable;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
  onCommand: (command: SlashCommand) => void;
}

const MAX_HEIGHT = 10;

/**
 * Inline slash completion modeled on OpenCode's OpenTUI prompt autocomplete.
 * Based on https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx
 */
export class SlashAutocomplete {
  readonly container: BoxRenderable;

  private readonly input: InputRenderable;
  private readonly select: SelectRenderable;
  private readonly onCommand: (command: SlashCommand) => void;
  private hasMatches = false;

  constructor(options: SlashAutocompleteOptions) {
    this.input = options.input;
    this.onCommand = options.onCommand;
    this.container = new BoxRenderable(options.renderer, {
      id: options.nextId("slash-menu"),
      height: 0,
      visible: false,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.select = new SelectRenderable(options.renderer, {
      id: options.nextId("slash-select"),
      height: 0,
      options: [],
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      focusedTextColor: options.theme.foreground,
      selectedBackgroundColor: options.theme.selectionBackground,
      selectedTextColor: options.theme.selectionForeground,
      textColor: options.theme.foreground,
      descriptionColor: options.theme.dim,
      selectedDescriptionColor: options.theme.selectionForeground,
      showDescription: true,
      showScrollIndicator: false,
      showSelectionIndicator: true,
      wrapSelection: true,
    });
    this.container.add(this.select);
  }

  get visible(): boolean {
    return this.container.visible;
  }

  update(value: string): void {
    if (slashQuery(value) === undefined) {
      this.close();
      return;
    }

    const commands = slashSuggestions(value);
    this.hasMatches = commands.length > 0;
    const menuOptions: SelectOption[] = this.hasMatches
      ? commands.map((command) => ({
          name: `/${command.name}`,
          description: command.description,
          value: command.name,
        }))
      : [{ name: "No matching commands", description: "", value: undefined }];
    const height = Math.min(Math.max(menuOptions.length * 2, 2), MAX_HEIGHT);
    this.select.options = menuOptions;
    this.select.selectedIndex = 0;
    this.select.showSelectionIndicator = this.hasMatches;
    this.select.showScrollIndicator = menuOptions.length * 2 > height;
    this.select.height = height;
    this.container.height = height;
    this.container.visible = true;
  }

  handleKey(key: KeyEvent): boolean {
    if (!this.visible) return false;

    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      this.select.moveUp();
      return this.consume(key);
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      this.select.moveDown();
      return this.consume(key);
    }
    if (key.name === "escape") {
      this.input.value = "";
      this.close();
      return this.consume(key);
    }
    if (key.name !== "return" && key.name !== "tab") return false;

    if (!this.hasMatches) return this.consume(key);
    const selected = this.select.getSelectedOption();
    const name = typeof selected?.value === "string" ? selected.value : undefined;
    const command = name === undefined ? undefined : resolveSlashCommand(name);
    if (command === undefined) return this.consume(key);

    const query = slashQuery(this.input.value);
    const exact =
      query === command.name || command.aliases?.some((alias) => alias === query) === true;
    if (key.name === "tab" || (command.acceptsArgument === true && !exact)) {
      this.input.value = `/${command.name}${command.acceptsArgument === true ? " " : ""}`;
      this.close();
      this.input.focus();
      return this.consume(key);
    }

    this.input.value = "";
    this.close();
    this.onCommand(command);
    return this.consume(key);
  }

  close(): void {
    this.container.visible = false;
    this.container.height = 0;
    this.select.height = 0;
  }

  destroy(): void {
    this.container.destroy();
  }

  private consume(key: KeyEvent): true {
    key.preventDefault();
    key.stopPropagation();
    return true;
  }
}
