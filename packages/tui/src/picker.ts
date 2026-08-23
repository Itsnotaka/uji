import {
  bold,
  BoxRenderable,
  CliRenderEvents,
  fg,
  InputRenderable,
  InputRenderableEvents,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";
import { MenuList } from "./menu-list.ts";
import type { MenuItem } from "./menu-list.ts";
import { GLYPHS } from "./constants.ts";
import type { CliTheme } from "./theme.ts";

export type Choice = MenuItem;

export class PickerCancelled extends Error {
  constructor() {
    super("Selection cancelled");
  }
}

/**
 * An extra key bound to the highlighted row. It acts on that row and closes
 * the menu, so a queue can be edited or emptied without reaching for a mouse.
 */
export interface ChoiceAction {
  /** Key name as OpenTUI reports it, e.g. `"e"` or `"delete"`. */
  readonly key: string;
  readonly ctrl: boolean;
  readonly label: string;
  readonly run: (id: string) => void;
}

/**
 * One list the menu shows. Screens swap in place, so stepping from settings
 * into the model list costs no rebuild, and `load` lets a screen paint what is
 * already known and fill in the slow source behind the frame.
 */
export interface MenuScreen {
  readonly title: string;
  readonly choices: readonly Choice[];
  readonly load?: () => Promise<readonly Choice[]>;
  readonly selectedId?: string;
  readonly maxVisible?: number;
  readonly actions?: readonly ChoiceAction[];
  /** Verb on the enter keycap. */
  readonly selectLabel?: string;
  /** Verb on the escape keycap; sub-screens go "back", top screens "close". */
  readonly cancelLabel?: string;
  readonly onSelect: (id: string) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly onHighlight?: (id: string) => void;
}

interface InlineMenuOptions {
  renderer: CliRenderer;
  theme: CliTheme;
  nextId?: (prefix?: string) => string;
  onError?: (error: unknown) => void;
}

function consume(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

function actionKeyLabel(action: ChoiceAction): string {
  return action.ctrl ? `ctrl+${action.key}` : action.key;
}

function filterChoices(choices: readonly Choice[], value: string): readonly Choice[] {
  const query = value.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (query.length === 0) return choices;
  return choices.filter((choice) => {
    const searchable =
      `${choice.label} ${choice.description ?? ""} ${choice.id}`.toLocaleLowerCase();
    return query.every((part) => searchable.includes(part));
  });
}

const MAX_ROWS = 10;
// Composer, powerline, panel padding, the search row, and the global hint row
// take six terminal rows before the list gets any.
const CHROME_ROWS = 7;
/**
 * The composer spends a border column and a padding column on each side, so
 * matching its inner span means two columns on the left, under the prompt
 * glyph, and one on the right.
 */
const PADDING_LEFT = 2;
const PADDING_RIGHT = 1;

/**
 * The one menu behind every inline choice: borderless, under the composer, on
 * the composer's rail. Picking a model, a thinking level, a setting or a slash
 * command is the same gesture, so all of them take the same chrome instead of
 * a window over the chat.
 *
 * Based on Grok Build's slash dropdown:
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/views/slash_dropdown.rs
 */
export class InlineMenu {
  readonly container: BoxRenderable;
  readonly queryInput: InputRenderable;

  private readonly renderer: CliRenderer;
  private readonly theme: CliTheme;
  private readonly title: TextRenderable;
  private readonly list: MenuList;
  private readonly count: TextRenderable;
  private readonly empty: TextRenderable;
  private readonly onError: (error: unknown) => void;
  private screen: MenuScreen;
  private choices: readonly Choice[];
  private matches: readonly Choice[];
  private loading = false;
  private filtering = true;
  private busy = false;
  private destroyed = false;

  constructor(options: InlineMenuOptions, screen: MenuScreen) {
    this.renderer = options.renderer;
    this.theme = options.theme;
    this.onError = options.onError ?? (() => undefined);
    this.screen = screen;
    this.choices = screen.choices;
    this.matches = screen.choices;
    const { theme } = options;
    const nextId = options.nextId ?? ((prefix = "menu") => `${prefix}-${crypto.randomUUID()}`);

    this.container = new BoxRenderable(options.renderer, {
      id: nextId("menu-panel"),
      flexShrink: 0,
      flexDirection: "column",
      // No panel fill: the menu belongs to the composer, not to a window over
      // it. Only the selected row takes a background.
      backgroundColor: theme.transparent,
      marginLeft: 1,
      marginRight: 1,
      paddingLeft: PADDING_LEFT,
      paddingRight: PADDING_RIGHT,
      paddingTop: 1,
      paddingBottom: 1,
    });

    const queryRow = new BoxRenderable(options.renderer, {
      id: nextId("menu-query-row"),
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    });
    this.title = new TextRenderable(options.renderer, {
      id: nextId("menu-title"),
      content: this.titleText(screen.title),
      wrapMode: "none",
      flexShrink: 0,
    });
    queryRow.add(this.title);
    this.queryInput = new InputRenderable(options.renderer, {
      id: nextId("menu-query"),
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 1,
      placeholder: "type to filter",
      placeholderColor: theme.muted,
      backgroundColor: theme.transparent,
      focusedBackgroundColor: theme.transparent,
      textColor: theme.foreground,
      focusedTextColor: theme.foreground,
      cursorColor: theme.accent,
      selectionBg: theme.selectionBackground,
      selectionFg: theme.selectionForeground,
    });
    queryRow.add(this.queryInput);
    this.count = new TextRenderable(options.renderer, {
      id: nextId("menu-count"),
      content: this.countText(),
      fg: theme.dim,
      wrapMode: "none",
      flexShrink: 0,
    });
    queryRow.add(this.count);

    this.list = new MenuList({
      renderer: options.renderer,
      theme,
      nextId,
      background: theme.transparent,
      maxVisible: this.maxVisibleForHeight(options.renderer.height),
      items: this.matches,
      selectedIndex: this.indexOf(screen.selectedId),
      onSelect: (item) => this.activate(item.id),
      onHighlight: (item) => this.screen.onHighlight?.(item.id),
    });
    this.empty = new TextRenderable(options.renderer, {
      id: nextId("menu-empty"),
      content: "no matches",
      fg: theme.dim,
      visible: false,
    });

    this.container.add(queryRow);
    this.container.add(this.list.container);
    this.container.add(this.empty);

    options.renderer.keyInput.on("keypress", this.onKeyPress);
    options.renderer.on(CliRenderEvents.RESIZE, this.onResize);
    this.queryInput.on(InputRenderableEvents.INPUT, this.onInput);
    this.repaintStatus();
    this.startLoad();
  }

  /** Keycap row for the shell's hint line while this menu owns the input. */
  get hints(): string {
    return [
      `enter ${this.screen.selectLabel ?? "select"}`,
      ...(this.screen.actions ?? []).map((action) => `${actionKeyLabel(action)} ${action.label}`),
      "↑↓ move",
      `esc ${this.screen.cancelLabel ?? "close"}`,
    ].join(" · ");
  }

  show(screen: MenuScreen): void {
    if (this.destroyed) return;
    this.screen = screen;
    this.choices = screen.choices;
    this.title.content = this.titleText(screen.title);
    this.setQuery("");
    this.matches = screen.choices;
    this.list.setMaxVisible(this.maxVisibleForHeight(this.renderer.height));
    this.list.setItems(this.matches, this.indexOf(screen.selectedId));
    this.repaintStatus();
    this.startLoad();
  }

  focus(): void {
    this.queryInput.focus();
  }

  blur(): void {
    this.queryInput.blur();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.keyInput.off("keypress", this.onKeyPress);
    this.renderer.off(CliRenderEvents.RESIZE, this.onResize);
    this.queryInput.off(InputRenderableEvents.INPUT, this.onInput);
    this.container.parent?.remove(this.container);
    this.container.destroyRecursively();
  }

  /** Fills a screen from its slow source, dropping results the user moved past. */
  private startLoad(): void {
    const { screen } = this;
    if (screen.load === undefined) return;
    this.loading = true;
    this.repaintStatus();
    void screen
      .load()
      .then((choices) => {
        if (this.destroyed || this.screen !== screen) return;
        const highlighted = this.list.selectedItem?.id;
        this.choices = choices;
        this.matches = filterChoices(choices, this.queryInput.value);
        this.list.setItems(this.matches, this.indexOf(highlighted ?? screen.selectedId));
      })
      .catch(this.onError)
      .finally(() => {
        if (this.destroyed || this.screen !== screen) return;
        this.loading = false;
        this.repaintStatus();
        this.renderer.requestRender();
      });
  }

  private titleText(title: string): StyledText {
    return new StyledText([
      bold(fg(this.theme.accent)(title)),
      fg(this.theme.muted)(`  ${GLYPHS.separator} `),
    ]);
  }

  private countText(): string {
    const total = this.choices.length;
    return this.matches.length === total
      ? ` ${String(total)}`
      : ` ${String(this.matches.length)}/${String(total)}`;
  }

  private indexOf(id: string | undefined): number {
    return Math.max(
      0,
      this.matches.findIndex((choice) => choice.id === id),
    );
  }

  private setQuery(value: string): void {
    this.filtering = false;
    this.queryInput.value = value;
    this.filtering = true;
  }

  private repaintStatus(): void {
    this.count.content = this.countText();
    this.empty.content = this.loading ? "loading" : "no matches";
    this.list.container.visible = this.matches.length > 0;
    this.empty.visible = this.matches.length === 0;
  }

  private maxVisibleForHeight(height: number): number {
    const cap = Math.max(1, Math.floor(this.screen.maxVisible ?? MAX_ROWS));
    return Math.max(1, Math.min(cap, height - CHROME_ROWS));
  }

  private readonly onResize = (_width: number, height: number): void => {
    this.list.setMaxVisible(this.maxVisibleForHeight(height));
  };

  private readonly onInput = (value: string): void => {
    if (!this.filtering) return;
    this.matches = filterChoices(this.choices, value);
    this.list.setItems(this.matches);
    const top = this.list.selectedItem;
    if (top !== undefined) this.screen.onHighlight?.(top.id);
    this.repaintStatus();
  };

  private activate(id: string): void {
    if (this.busy) return;
    const { onSelect } = this.screen;
    this.busy = true;
    void Promise.resolve()
      .then(() => onSelect(id))
      .catch(this.onError)
      .finally(() => {
        this.busy = false;
      });
  }

  private readonly onKeyPress = (key: KeyEvent): void => {
    if (this.destroyed || key.defaultPrevented) return;
    // A choice mid-apply owns the menu: swallow keys instead of racing it.
    if (this.busy) {
      consume(key);
      return;
    }
    if (key.name === "escape") {
      consume(key);
      if (this.queryInput.value === "") this.screen.onCancel();
      else this.queryInput.value = "";
      return;
    }
    if (this.matches.length === 0) return;
    const highlighted = this.list.selectedItem;
    const action =
      highlighted === undefined || key.meta || key.shift
        ? undefined
        : (this.screen.actions ?? []).find(
            (candidate) => candidate.key === key.name && candidate.ctrl === key.ctrl,
          );
    if (action !== undefined && highlighted !== undefined) {
      consume(key);
      this.screen.onCancel();
      action.run(highlighted.id);
      return;
    }
    if (key.name === "return") {
      consume(key);
      this.list.selectCurrent();
      return;
    }
    if (this.list.handleNavigationKey(key)) consume(key);
  };
}
