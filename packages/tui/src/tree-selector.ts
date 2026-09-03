/**
 * The session tree as a picker: every turn on every branch, the head's path
 * marked, one row highlighted. Enter hands the highlighted entry back to the
 * shell, which decides what a move to it means.
 *
 * Layout and filtering follow pi's tree selector; the chrome is the inline
 * menu's, so opening the tree is the same gesture as picking a model.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/tree-selector.ts
 */
import {
  bold,
  BoxRenderable,
  CliRenderEvents,
  createTextAttributes,
  fg,
  InputRenderable,
  InputRenderableEvents,
  parseColor,
  Renderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import type {
  CliRenderer,
  KeyEvent,
  MouseEvent,
  OptimizedBuffer,
  RenderableOptions,
  RGBA,
} from "@opentui/core";
import type { SessionTree, SessionTreeNode } from "@uji-ai/core";
import { GLYPHS } from "./constants.ts";
import { PickerCancelled } from "./picker.ts";
import type { CliTheme } from "./theme.ts";
import { setHints } from "./tui.ts";
import type { Ui } from "./tui.ts";
import { displayWidth, truncateDisplay } from "./width.ts";
import type { Entry } from "@uji-ai/core/store";

export type TreeFilter = "default" | "users" | "all";

/** One drawn row of the tree. */
interface TreeRow {
  readonly id: string;
  readonly entry: Entry;
  /** Gutters and connectors, three cells per level. */
  readonly prefix: string;
  /** On the path from the root to the head's leaf. */
  readonly active: boolean;
  readonly role:
    | "user"
    | "assistant"
    | "tool"
    | "compaction"
    | "branch_summary"
    | "model"
    | "thinking"
    | "custom";
  /** The role word before the text, e.g. `user:`. */
  readonly label: string;
  readonly text: string;
}

interface Gutter {
  position: number;
  show: boolean;
}

interface VisibleNode {
  node: SessionTreeNode;
  children: VisibleNode[];
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .join(" ");
}

function assistantText(message: Extract<Entry, { type: "message" }>["message"]): string {
  if (message.role !== "assistant") return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
}

function describe(entry: Entry): Pick<TreeRow, "role" | "label" | "text"> {
  switch (entry.type) {
    case "message": {
      const { message } = entry;
      switch (message.role) {
        case "user":
          return { role: "user", label: "user:", text: oneLine(contentText(message.content)) };
        case "assistant": {
          const text = oneLine(assistantText(message));
          if (text !== "") return { role: "assistant", label: "assistant:", text };
          if (message.stopReason === "aborted") {
            return { role: "assistant", label: "assistant:", text: "(aborted)" };
          }
          if (message.errorMessage !== undefined) {
            return { role: "assistant", label: "assistant:", text: oneLine(message.errorMessage) };
          }
          return { role: "assistant", label: "assistant:", text: "(tool calls)" };
        }
        case "toolResult":
          return { role: "tool", label: `[${message.toolName}]`, text: "" };
        default: {
          const _exhaustive: never = message;
          return _exhaustive;
        }
      }
    }
    case "compaction":
      return {
        role: "compaction",
        label: `[compaction: ${String(Math.round(entry.tokensBefore / 1000))}k tokens]`,
        text: "",
      };
    case "branch_summary":
      return { role: "branch_summary", label: "[branch summary]", text: oneLine(entry.summary) };
    case "model_change":
      return { role: "model", label: `[model: ${entry.modelId}]`, text: "" };
    case "thinking_level_change":
      return { role: "thinking", label: `[thinking: ${entry.thinkingLevel}]`, text: "" };
    case "agent_change":
      return { role: "model", label: `[agent: ${entry.agentId}]`, text: "" };
    case "custom":
      return { role: "custom", label: `[${entry.customType}]`, text: "" };
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

function hasAssistantText(entry: Entry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  return assistantText(entry.message).trim() !== "";
}

/** Whether a node shows under a filter; the head's leaf always does. */
function passes(node: SessionTreeNode, filter: TreeFilter, leafId: string | null): boolean {
  const { entry } = node;
  if (entry.id === leafId) return true;
  switch (filter) {
    case "all":
      return true;
    case "users":
      return entry.type === "message" && entry.message.role === "user";
    case "default":
      if (entry.type === "message") {
        if (entry.message.role === "toolResult") return false;
        if (entry.message.role === "assistant") {
          const aborted =
            entry.message.stopReason === "aborted" || entry.message.stopReason === "error";
          return hasAssistantText(entry) || aborted || entry.message.errorMessage !== undefined;
        }
        return true;
      }
      return entry.type === "compaction" || entry.type === "branch_summary";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

function matches(node: SessionTreeNode, query: string): boolean {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const described = describe(node.entry);
  const haystack = `${described.label} ${described.text} ${node.entry.id}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * The visible tree: hidden nodes drop out and their children attach to the
 * nearest visible ancestor, so a filtered view keeps its branch points.
 */
function visibleForest(
  roots: readonly SessionTreeNode[],
  keep: (node: SessionTreeNode) => boolean,
): VisibleNode[] {
  const collect = (node: SessionTreeNode): VisibleNode[] => {
    const children = node.children.flatMap(collect);
    return keep(node) ? [{ node, children }] : children;
  };
  return roots.flatMap(collect);
}

function containsActive(node: VisibleNode): boolean {
  return node.node.active || node.children.some(containsActive);
}

/**
 * Flatten with pi's indentation: a branch point indents its children, the
 * first generation after a branch indents once more for grouping, and a
 * single-child chain stays flat.
 */
export function layoutTree(
  tree: SessionTree,
  options: { filter?: TreeFilter; query?: string } = {},
): TreeRow[] {
  const filter = options.filter ?? "default";
  const query = options.query ?? "";
  const forest = visibleForest(
    tree.roots,
    (node) => passes(node, filter, tree.leafId) && matches(node, query),
  );
  const multipleRoots = forest.length > 1;
  const rows: TreeRow[] = [];

  const visit = (
    item: VisibleNode,
    indent: number,
    justBranched: boolean,
    showConnector: boolean,
    isLast: boolean,
    gutters: readonly Gutter[],
    isRoot: boolean,
  ): void => {
    const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
    const connector = showConnector && !isRoot;
    const connectorPosition = connector ? displayIndent - 1 : -1;
    const cells: string[] = [];
    for (let cell = 0; cell < displayIndent * 3; cell++) {
      const level = Math.floor(cell / 3);
      const offset = cell % 3;
      const gutter = gutters.find((candidate) => candidate.position === level);
      if (gutter !== undefined) {
        cells.push(offset === 0 && gutter.show ? "│" : " ");
      } else if (connector && level === connectorPosition) {
        cells.push(offset === 0 ? (isLast ? "└" : "├") : offset === 1 ? "─" : " ");
      } else {
        cells.push(" ");
      }
    }
    const { entry } = item.node;
    rows.push({
      id: entry.id,
      entry,
      prefix: cells.join(""),
      active: item.node.active,
      ...describe(entry),
    });

    const ordered = [...item.children].sort(
      (left, right) => Number(containsActive(right)) - Number(containsActive(left)),
    );
    const multiple = ordered.length > 1;
    const childIndent = multiple || (justBranched && indent > 0) ? indent + 1 : indent;
    const childGutters = connector
      ? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }]
      : gutters;
    for (const [index, child] of ordered.entries()) {
      visit(
        child,
        childIndent,
        multiple,
        multiple,
        index === ordered.length - 1,
        childGutters,
        false,
      );
    }
  };

  const orderedRoots = [...forest].sort(
    (left, right) => Number(containsActive(right)) - Number(containsActive(left)),
  );
  for (const [index, root] of orderedRoots.entries()) {
    visit(
      root,
      multipleRoots ? 1 : 0,
      multipleRoots,
      multipleRoots,
      index === orderedRoots.length - 1,
      [],
      true,
    );
  }
  return rows;
}

/** The row's plain text, as drawn: prefix, path marker, label, text. */
export function treeRowText(row: TreeRow): string {
  const marker = row.active ? "• " : "";
  return `${row.prefix}${marker}${row.label}${row.text === "" ? "" : ` ${row.text}`}`;
}

/** Index of `id`, else of its nearest ancestor with a row, else the last row. */
export function nearestRowIndex(
  rows: readonly TreeRow[],
  byId: ReadonlyMap<string, Entry>,
  id: string | null,
): number {
  const index = new Map(rows.map((row, position) => [row.id, position]));
  let current = id;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const found = index.get(current);
    if (found !== undefined) return found;
    current = byId.get(current)?.parentId ?? null;
  }
  return Math.max(0, rows.length - 1);
}

const PREFIX_WIDTH = 2;
const MAX_ROWS = 12;
const CHROME_ROWS = 7;
/** Padding rows plus the query row: what the panel adds around its list. */
const PANEL_CHROME_ROWS = 3;
const PADDING_LEFT = 2;
const PADDING_RIGHT = 1;

interface TreeRowsOptions extends RenderableOptions<TreeRows> {
  theme: CliTheme;
  onSelectionChanged: (index: number) => void;
}

/** Rows drawn straight onto the buffer, one per tree entry, as tall as the list. */
class TreeRows extends Renderable {
  private rows: readonly TreeRow[] = [];
  private selected = 0;
  private hovered: number | undefined;
  private readonly notifySelectionChanged: (index: number) => void;
  private readonly theme: CliTheme;
  private readonly rowBackground: RGBA;
  private readonly selectedBackground: RGBA;
  private readonly hoverBackground: RGBA;
  private readonly boldAttributes = createTextAttributes({ bold: true });

  constructor(ctx: CliRenderer, options: TreeRowsOptions) {
    super(ctx, options);
    this.theme = options.theme;
    this.notifySelectionChanged = options.onSelectionChanged;
    this.rowBackground = parseColor(options.theme.transparent);
    this.selectedBackground = parseColor(options.theme.selectionBackground);
    this.hoverBackground = parseColor(options.theme.hover);
  }

  setRows(rows: readonly TreeRow[], selectedIndex: number): void {
    this.hovered = undefined;
    this.rows = rows;
    this.height = Math.max(1, rows.length);
    this.selected = -1;
    this.setSelectedIndex(selectedIndex);
    this.requestRender();
  }

  getSelectedIndex(): number {
    return this.selected;
  }

  setSelectedIndex(index: number): void {
    const next = Math.min(Math.max(0, index), Math.max(0, this.rows.length - 1));
    if (next === this.selected) return;
    this.selected = next;
    this.requestRender();
    this.notifySelectionChanged(next);
  }

  moveBy(steps: number): void {
    const count = this.rows.length;
    if (count > 0) this.setSelectedIndex((((this.selected + steps) % count) + count) % count);
  }

  indexAt(y: number): number | undefined {
    const index = y - this.screenY;
    return index >= 0 && index < this.rows.length ? index : undefined;
  }

  setHovered(index: number | undefined): void {
    if (index === this.hovered) return;
    this.hovered = index;
    this.requestRender();
  }

  private roleColor(row: TreeRow): string {
    switch (row.role) {
      case "user":
        return this.theme.accent;
      case "assistant":
        return this.theme.ok;
      case "branch_summary":
      case "compaction":
        return this.theme.warning;
      case "tool":
      case "model":
      case "thinking":
      case "custom":
        return this.theme.muted;
      default: {
        const _exhaustive: never = row.role;
        return _exhaustive;
      }
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer, _deltaTime: number): void {
    if (!this.visible) return;
    const left = this.x;
    const top = this.y;
    buffer.fillRect(left, top, this.width, this.height, this.rowBackground);
    const textWidth = this.width - PREFIX_WIDTH;
    for (const [index, row] of this.rows.entries()) {
      const selected = index === this.selected;
      const background = selected
        ? this.selectedBackground
        : index === this.hovered
          ? this.hoverBackground
          : this.rowBackground;
      buffer.fillRect(left, top + index, this.width, 1, background);
      buffer.drawText(
        selected ? `${GLYPHS.prompt} ` : "  ",
        left,
        top + index,
        parseColor(selected ? this.theme.selectionForeground : this.theme.foreground),
        background,
      );
      if (textWidth <= 0) continue;
      const attributes = selected ? this.boldAttributes : undefined;
      let x = left + PREFIX_WIDTH;
      let remaining = textWidth;
      const draw = (text: string, color: string): void => {
        if (remaining <= 0 || text === "") return;
        const shown = truncateDisplay(text, remaining, remaining > 1 ? GLYPHS.ellipsis : "");
        const foreground = selected ? this.theme.selectionForeground : color;
        buffer.drawText(shown, x, top + index, parseColor(foreground), background, attributes);
        const width = displayWidth(shown);
        x += width;
        remaining -= width;
      };
      draw(row.prefix, this.theme.dim);
      if (row.active) draw("• ", this.theme.accent);
      draw(row.label, this.roleColor(row));
      if (row.text !== "") draw(` ${row.text}`, this.theme.foreground);
    }
  }
}

interface TreeSelectorOptions {
  readonly tree: SessionTree;
  /** Initial highlight; defaults to the head's leaf. */
  readonly selectedId?: string | null;
  /** Rows to show first; `default` hides tool results and bookkeeping. */
  readonly filter?: TreeFilter;
  readonly signal?: AbortSignal;
}

interface TreeSelectorShell {
  renderer: CliRenderer;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
  /** The panel's row count changed; the shell resizes the slot it borrows. */
  onRows?: (rows: number) => void;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

function consume(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

/** The tree picker itself: query row, rows, and the keys that move through them. */
class TreeSelector {
  readonly container: BoxRenderable;
  readonly queryInput: InputRenderable;

  private readonly renderer: CliRenderer;
  private readonly theme: CliTheme;
  private readonly tree: SessionTree;
  private readonly byId: ReadonlyMap<string, Entry>;
  private readonly title: TextRenderable;
  private readonly count: TextRenderable;
  private readonly empty: TextRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly list: TreeRows;
  private readonly onSelect: (id: string) => void;
  private readonly onCancel: () => void;
  private readonly onRows: (rows: number) => void;
  private layout: TreeRow[] = [];
  private filter: TreeFilter;
  private query = "";
  private filtering = true;
  private maxVisible = MAX_ROWS;
  private lastSelectedId: string | null;
  private destroyed = false;

  constructor(shell: TreeSelectorShell, options: TreeSelectorOptions) {
    this.renderer = shell.renderer;
    this.theme = shell.theme;
    this.tree = options.tree;
    this.onSelect = shell.onSelect;
    this.onCancel = shell.onCancel;
    this.onRows = shell.onRows ?? (() => undefined);
    this.filter = options.filter ?? "default";
    this.lastSelectedId =
      options.selectedId === undefined ? options.tree.leafId : options.selectedId;
    const byId = new Map<string, Entry>();
    const index = (node: SessionTreeNode): void => {
      byId.set(node.entry.id, node.entry);
      for (const child of node.children) index(child);
    };
    for (const root of options.tree.roots) index(root);
    this.byId = byId;
    const { theme, nextId } = shell;

    this.container = new BoxRenderable(shell.renderer, {
      id: nextId("tree-panel"),
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: theme.transparent,
      marginLeft: 1,
      marginRight: 1,
      paddingLeft: PADDING_LEFT,
      paddingRight: PADDING_RIGHT,
      paddingTop: 1,
      paddingBottom: 1,
    });
    const queryRow = new BoxRenderable(shell.renderer, {
      id: nextId("tree-query-row"),
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
    });
    this.title = new TextRenderable(shell.renderer, {
      id: nextId("tree-title"),
      content: new StyledText([
        bold(fg(theme.accent)("Session tree")),
        fg(theme.muted)(`  ${GLYPHS.separator} `),
      ]),
      wrapMode: "none",
      flexShrink: 0,
    });
    queryRow.add(this.title);
    this.queryInput = new InputRenderable(shell.renderer, {
      id: nextId("tree-query"),
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
    this.count = new TextRenderable(shell.renderer, {
      id: nextId("tree-count"),
      content: "",
      fg: theme.dim,
      wrapMode: "none",
      flexShrink: 0,
    });
    queryRow.add(this.count);

    this.scroll = new ScrollBoxRenderable(shell.renderer, {
      id: nextId("tree-scroll"),
      width: "100%",
      scrollY: true,
      scrollX: false,
      verticalScrollbarOptions: { showArrows: false },
      horizontalScrollbarOptions: { visible: false },
      contentOptions: { flexDirection: "column" },
    });
    this.list = new TreeRows(shell.renderer, {
      id: nextId("tree-rows"),
      width: "100%",
      height: 1,
      theme,
      onSelectionChanged: (selected) => {
        this.scrollIntoView(selected);
        this.lastSelectedId = this.layout[selected]?.id ?? this.lastSelectedId;
      },
      onMouseDown: (event: MouseEvent) => this.onMouseDown(event),
      onMouseMove: (event: MouseEvent) => this.list.setHovered(this.list.indexAt(event.y)),
      onMouseOut: () => this.list.setHovered(undefined),
    });
    this.scroll.add(this.list);
    this.empty = new TextRenderable(shell.renderer, {
      id: nextId("tree-empty"),
      content: "no matches",
      fg: theme.dim,
      visible: false,
    });

    this.container.add(queryRow);
    this.container.add(this.scroll);
    this.container.add(this.empty);

    this.maxVisible = this.maxVisibleForHeight(shell.renderer.height);
    shell.renderer.keyInput.on("keypress", this.onKeyPress);
    shell.renderer.on(CliRenderEvents.RESIZE, this.onResize);
    this.queryInput.on(InputRenderableEvents.INPUT, this.onInput);
    this.relayout();
  }

  get hints(): string {
    return "enter select · ↑↓ move · ctrl+u users · ctrl+a all · esc close";
  }

  /** Rows the panel needs right now: declared, not measured. */
  get rows(): number {
    return PANEL_CHROME_ROWS + Math.max(1, Math.min(this.layout.length, this.maxVisible));
  }

  /** The highlighted entry id, or undefined when nothing matches. */
  get selectedId(): string | undefined {
    return this.layout[this.list.getSelectedIndex()]?.id;
  }

  get rowsShown(): readonly TreeRow[] {
    return this.layout;
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

  setFilter(filter: TreeFilter): void {
    this.filter = filter;
    this.relayout();
  }

  private relayout(): void {
    this.layout = layoutTree(this.tree, { filter: this.filter, query: this.query });
    const selected = nearestRowIndex(this.layout, this.byId, this.lastSelectedId);
    this.list.setRows(this.layout, selected);
    if (this.layout.length > 0) this.lastSelectedId = this.layout[selected]?.id ?? null;
    this.scroll.height = Math.max(1, Math.min(this.layout.length, this.maxVisible));
    this.scroll.visible = this.layout.length > 0;
    this.empty.visible = this.layout.length === 0;
    const mode = this.filter === "default" ? "" : ` ${GLYPHS.separator} ${this.filter}`;
    this.count.content = ` ${String(this.layout.length)}${mode}`;
    this.scroll.scrollTo(0);
    this.scrollIntoView(selected);
    this.onRows(this.rows);
    this.renderer.requestRender();
  }

  private scrollIntoView(index: number): void {
    const top = this.scroll.scrollTop;
    if (index < top) this.scroll.scrollTo(index);
    else if (index >= top + this.maxVisible) this.scroll.scrollTo(index - this.maxVisible + 1);
  }

  private maxVisibleForHeight(height: number): number {
    return Math.max(1, Math.min(MAX_ROWS, height - CHROME_ROWS));
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const index = this.list.indexAt(event.y);
    if (index === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    this.list.setSelectedIndex(index);
    const id = this.selectedId;
    if (id !== undefined) this.onSelect(id);
  }

  private readonly onResize = (_width: number, height: number): void => {
    this.maxVisible = this.maxVisibleForHeight(height);
    this.relayout();
  };

  private readonly onInput = (value: string): void => {
    if (!this.filtering) return;
    this.query = value;
    this.relayout();
  };

  private setQuery(value: string): void {
    this.filtering = false;
    this.queryInput.value = value;
    this.filtering = true;
    this.query = value;
  }

  private readonly onKeyPress = (key: KeyEvent): void => {
    if (this.destroyed || key.defaultPrevented) return;
    if (key.name === "escape") {
      consume(key);
      if (this.query === "") this.onCancel();
      else {
        this.setQuery("");
        this.relayout();
      }
      return;
    }
    if (key.ctrl && key.name === "u") {
      consume(key);
      this.setFilter(this.filter === "users" ? "default" : "users");
      return;
    }
    if (key.ctrl && key.name === "a") {
      consume(key);
      this.setFilter(this.filter === "all" ? "default" : "all");
      return;
    }
    if (this.layout.length === 0) return;
    if (key.name === "return") {
      consume(key);
      const id = this.selectedId;
      if (id !== undefined) this.onSelect(id);
      return;
    }
    const page = Math.max(1, this.maxVisible - 1);
    if (key.name === "up" || (key.ctrl && key.name === "p") || (key.shift && key.name === "tab")) {
      this.list.moveBy(-1);
    } else if (
      key.name === "down" ||
      (key.ctrl && key.name === "n") ||
      (key.name === "tab" && !key.shift)
    ) {
      this.list.moveBy(1);
    } else if (key.name === "pageup") {
      this.list.setSelectedIndex(Math.max(0, this.list.getSelectedIndex() - page));
    } else if (key.name === "pagedown") {
      this.list.setSelectedIndex(
        Math.min(this.layout.length - 1, this.list.getSelectedIndex() + page),
      );
    } else {
      return;
    }
    consume(key);
  };
}

/** One-shot tree picker over the composer: resolves with the chosen entry id. */
export function selectTreeEntry(ui: Ui, options: TreeSelectorOptions): Promise<string> {
  if (ui.selecting) return Promise.reject(new Error("Another menu is already open"));
  if (options.signal?.aborted === true) return Promise.reject(new PickerCancelled());
  const restoredHints = ui.hintText;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let selector: TreeSelector | undefined;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      ui.ephemeral.clear();
      selector?.destroy();
      ui.selecting = false;
      ui.focus.reset();
      setHints(ui, restoredHints);
      ui.renderer.requestRender();
      finish();
    };
    const onAbort = (): void => settle(() => reject(new PickerCancelled()));
    selector = new TreeSelector(
      {
        renderer: ui.renderer,
        theme: ui.transcript.theme,
        nextId: ui.nextId,
        onRows: (rows) => ui.ephemeral.setRows(rows),
        onSelect: (id) => settle(() => resolve(id)),
        onCancel: () => settle(() => reject(new PickerCancelled())),
      },
      options,
    );
    ui.closeInlineMenus?.();
    ui.ephemeral.mount(selector.container, selector.rows);
    setHints(ui, selector.hints);
    ui.selecting = true;
    ui.focus.use(selector);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
