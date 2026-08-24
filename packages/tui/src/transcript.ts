/**
 * Transcript blocks: the OpenTUI vocabulary for user, assistant, thinking, and
 * tool content. Live events and restored sessions both render through these,
 * so a resumed session looks like the one that was just typed.
 */
import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  fg,
  LineNumberRenderable,
  link,
  MarkdownRenderable,
  pathToFiletype,
  StyledText,
  SyntaxStyle,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer, LineColorConfig, OnChunksCallback, Renderable } from "@opentui/core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  UserMessage,
} from "@uji-ai/schema";
import type { CustomEntry, ProvisionedEntry, Turn, TurnPart } from "@uji-ai/core";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractFileAttachments,
  extractFileMentions,
  PASTE_COLLAPSE_LINES,
  pasteLineCount,
} from "./composer.ts";
import { renderDiagramFences } from "./diagram.ts";
import {
  describeToolCall,
  diffFromDetails,
  diffFromOutput,
  diffStat,
  formatDuration,
  omittedLabel,
  previewLines,
  relativePath,
  resultSummary,
  spinnerFrame,
  type OutputDiff,
  type ToolCallSummary,
} from "./format.ts";
import {
  ACTIVITY_FAILED_LABEL,
  ACTIVITY_STOPPED_LABEL,
  ACTIVITY_THINKING_LABEL,
  ACTIVITY_THOUGHT_LABEL,
  ACTIVITY_WORKED_LABEL,
  ACTIVITY_WORKING_LABEL,
  DIFF_PREVIEW_LINES,
  GLYPHS,
  RESULT_PREVIEW_LINES,
  RESULT_TAIL_LINES,
  SPACING,
  TOOL_INLINE_PREVIEW_LENGTH,
} from "./constants.ts";
import type { CliTheme } from "./theme.ts";
import { displayWidth } from "./width.ts";
import { collapsedImagePreview, collapsedTag } from "./collapsed-tag.ts";
import { syntaxHighlightedChunks } from "./highlight.ts";

/**
 * OpenTUI's line background fill rejects rows above the screen instead of
 * clipping them. Keep the colors for visible rows while a diff scrolls past
 * the top edge.
 */
function clipOffscreenDiffLineColors(diff: DiffRenderable): void {
  for (const child of diff.getChildren()) {
    if (!(child instanceof LineNumberRenderable)) continue;
    const colors = child.getLineColors();
    const lines = new Set([...colors.gutter.keys(), ...colors.content.keys()]);
    const lineColors = new Map<number, LineColorConfig>();
    for (const line of lines) {
      lineColors.set(line, {
        gutter: colors.gutter.get(line),
        content: colors.content.get(line),
      });
    }
    let appliedFirstSafeLine: number | undefined;
    const onSizeChange = child.onSizeChange;
    child.onSizeChange = () => {
      appliedFirstSafeLine = undefined;
      onSizeChange?.();
    };
    child.renderBefore = () => {
      const firstSafeLine = Math.max(0, Math.ceil(-child.screenY));
      if (firstSafeLine === appliedFirstSafeLine) return;
      appliedFirstSafeLine = firstSafeLine;
      child.setLineColors(new Map([...lineColors].filter(([line]) => line >= firstSafeLine)));
    };
  }
}

function inlineToolPreview(text: string): string | undefined {
  const value = text.trim();
  if (value === "" || value.includes("\n") || displayWidth(value) > TOOL_INLINE_PREVIEW_LENGTH) {
    return undefined;
  }
  return value;
}

function shikiChunks(theme: CliTheme): OnChunksCallback {
  return async (chunks, context) =>
    (await syntaxHighlightedChunks(context.content, context.filetype, theme)) ?? chunks;
}

function applyShikiToCodeChildren(root: Renderable, theme: CliTheme): void {
  const transform = shikiChunks(theme);
  const visit = (parent: Renderable): void => {
    for (const child of parent.getChildren()) {
      if (child instanceof CodeRenderable) child.onChunks = transform;
      visit(child);
    }
  };
  visit(root);
}

/**
 * Highlight groups, named as the shipped grammars emit them: markdown uses
 * `markup.strong`, and unlisted dotted names fall back to their first segment,
 * so `markup` has to carry headings, links, and fenced blocks.
 */
function syntaxStyle(theme: CliTheme, subtle: boolean): SyntaxStyle {
  const color = (value: string): string => (subtle ? theme.dim : value);
  return SyntaxStyle.fromStyles({
    default: { fg: color(theme.foreground) },
    markup: { fg: color(theme.foreground) },
    keyword: { fg: color(theme.code) },
    string: { fg: color(theme.string) },
    number: { fg: color(theme.number) },
    comment: { fg: color(theme.dim), italic: true },
    function: { fg: color(theme.user) },
    type: { fg: color(theme.type) },
    variable: { fg: color(theme.foreground) },
    operator: { fg: color(theme.operator) },
    punctuation: { fg: color(theme.dim) },
    "markup.heading": { fg: color(theme.foreground), bold: true },
    "markup.strong": { fg: color(theme.foreground), bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { fg: color(theme.dim) },
    "markup.raw": { fg: color(theme.code) },
    "markup.link": { fg: color(theme.link), underline: true },
    "markup.list": { fg: color(theme.dim) },
    "markup.quote": { fg: color(theme.dim), italic: true },
    conceal: { fg: color(theme.dim) },
  });
}

export function createSyntaxStyle(theme: CliTheme): SyntaxStyle {
  return syntaxStyle(theme, false);
}

/** Keep reasoning markdown structure while lowering every syntax foreground. */
export function createSubtleSyntaxStyle(theme: CliTheme): SyntaxStyle {
  return syntaxStyle(theme, true);
}

export interface Transcript {
  renderer: CliRenderer;
  container: Renderable;
  syntaxStyle: SyntaxStyle;
  subtleSyntaxStyle: SyntaxStyle;
  theme: CliTheme;
  /** Working directory of the harness whose entries are being rendered. */
  cwd?: string;
  nextId: (prefix?: string) => string;
  openPath?: (path: string) => void;
}

function section(
  transcript: Transcript,
  prefix: string,
  options: {
    backgroundColor?: string;
    marginTop?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
  } = {},
  parent: Renderable = transcript.container,
  before?: Renderable,
): BoxRenderable {
  const box = new BoxRenderable(transcript.renderer, {
    id: transcript.nextId(prefix),
    flexDirection: "column",
    backgroundColor: options.backgroundColor ?? transcript.theme.transparent,
    paddingTop: options.paddingTop ?? 0,
    paddingBottom: options.paddingBottom ?? 0,
    paddingLeft: options.paddingLeft ?? SPACING.inset,
    paddingRight: options.paddingRight ?? SPACING.insetRight,
    marginTop: options.marginTop ?? SPACING.block,
    width: "100%",
  });
  if (before === undefined) parent.add(box);
  else parent.insertBefore(box, before);
  return box;
}

function label(transcript: Transcript, text: string, color: string): TextRenderable {
  return new TextRenderable(transcript.renderer, {
    id: transcript.nextId("label"),
    content: text,
    fg: color,
  });
}

/** Hold a streamed heading marker until its text arrives. */
function hasIncompleteHeadingPrefix(text: string): boolean {
  const line = text.slice(text.lastIndexOf("\n") + 1);
  return /^\s{0,3}#{1,6}\s*$/.test(line);
}

/** A file the turn carried, with its body when the composer inlined one. */
interface PresentedFile {
  path: string;
  text?: string;
}

function userPresentation(content: UserMessage["content"]): {
  text: string;
  files: PresentedFile[];
  images: ImageContent[];
} {
  let text =
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  // An attached body is the file, not the prompt. It folds back into its tag so
  // the turn reads as what the user typed, and the tag can open it on demand.
  const files: PresentedFile[] = [];
  for (const attachment of extractFileAttachments(text)) {
    files.push({ path: attachment.path, text: attachment.text });
    text = text.replace(attachment.source, "");
  }
  for (const mention of extractFileMentions(text)) {
    files.push({ path: mention.path });
    text = text.replace(mention.source, "");
  }
  const images = typeof content === "string" ? [] : content.filter((part) => part.type === "image");
  // Older TUI messages stored image placeholders in their text. Image parts
  // are the durable source of truth now, so keep those markers presentation-only.
  if (images.length > 0) text = text.replace(/\[Image \d+\]/g, "");
  return {
    text: text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .trim(),
    files,
    images,
  };
}

/** Lines kept visible when a user message is folded. */
const PASTE_PREVIEW_LINES = 3;

function userText(theme: CliTheme, text: string): StyledText {
  return new StyledText([fg(theme.user)(`${GLYPHS.prompt} `), fg(theme.foreground)(text)]);
}

/**
 * A pasted wall of text is a fact about the turn, not the turn itself, so
 * anything past the composer's paste threshold arrives folded to a preview
 * with a tag that toggles the rest. Same click, same tag chrome as an image.
 */
function addUserText(transcript: Transcript, block: BoxRenderable, text: string): void {
  const lines = text.split("\n");
  const folded = lines.length > PASTE_COLLAPSE_LINES;
  const preview = lines.slice(0, PASTE_PREVIEW_LINES).join("\n");
  const body = new TextRenderable(transcript.renderer, {
    id: transcript.nextId("user-text"),
    content: userText(transcript.theme, folded ? preview : text),
    wrapMode: "word",
    selectionBg: transcript.theme.selectionBackground,
    selectionFg: transcript.theme.selectionForeground,
  });
  block.add(body);
  if (!folded) return;

  const hidden = lines.length - PASTE_PREVIEW_LINES;
  let expanded = false;
  collapsedTag(transcript, block, {
    id: "user-paste-toggle",
    marginTop: 1,
    label: () => (expanded ? " fewer lines " : ` +${String(hidden)} lines `),
    onToggle: () => {
      expanded = !expanded;
      body.content = userText(transcript.theme, expanded ? text : preview);
    },
  });
}

/**
 * A file the turn carried. When the composer inlined the body, the tag opens
 * it in place, the same gesture as an image or a fold; without a body there
 * is nothing to show, so the click falls back to opening the real file.
 */
function addFileTag(
  transcript: Transcript,
  block: BoxRenderable,
  tags: BoxRenderable,
  file: PresentedFile,
): void {
  const { path, text } = file;
  if (text === undefined) {
    collapsedTag(transcript, tags, {
      id: "file-tag",
      url: pathToFileURL(path).href,
      label: () => ` File ${basename(path)} `,
      onToggle: () => transcript.openPath?.(path),
    });
    return;
  }
  const body = new CodeRenderable(transcript.renderer, {
    id: transcript.nextId("file-body"),
    content: text,
    filetype: pathToFiletype(path) ?? undefined,
    syntaxStyle: transcript.syntaxStyle,
    onChunks: shikiChunks(transcript.theme),
    visible: false,
    marginTop: 1,
    selectionBg: transcript.theme.selectionBackground,
    selectionFg: transcript.theme.selectionForeground,
  });
  let open = false;
  collapsedTag(transcript, tags, {
    id: "file-tag",
    url: pathToFileURL(path).href,
    label: () => ` File ${basename(path)}${open ? "" : ` +${String(pasteLineCount(text))} lines`} `,
    onToggle: () => {
      open = !open;
      body.visible = open;
    },
  });
  block.add(body);
}

function addImageTag(
  transcript: Transcript,
  block: BoxRenderable,
  tags: BoxRenderable,
  image: ImageContent,
  index: number,
): void {
  const preview = collapsedImagePreview(transcript, image);
  collapsedTag(transcript, tags, {
    id: "image-tag",
    label: () => ` Image ${String(index)} `,
    onToggle: () => {
      preview.visible = !preview.visible;
      if (preview.visible) preview.onSizeChange?.();
    },
  });
  block.add(preview);
}

/**
 * A user turn: what was typed, then a row of tags for what it carried. Those
 * tags are the only mouse targets. The message itself does nothing on a click,
 * because taking a turn back is `esc esc` and moving the head is `/tree`, and a
 * pointer that happens to rest on a message is neither request.
 */
export function appendUser(
  transcript: Transcript,
  content: UserMessage["content"],
  parent?: Renderable,
): void {
  const presentation = userPresentation(content);
  const block = section(
    transcript,
    "user",
    {
      backgroundColor: transcript.theme.userBackground,
      marginTop: parent === undefined ? SPACING.block : 0,
      paddingTop: 1,
      paddingBottom: 1,
    },
    parent,
  );
  if (presentation.text !== "") addUserText(transcript, block, presentation.text);

  const tags = new BoxRenderable(transcript.renderer, {
    id: transcript.nextId("user-attachments"),
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 1,
    visible: presentation.files.length + presentation.images.length > 0,
    marginTop: presentation.text === "" ? 0 : 1,
  });
  block.add(tags);
  for (const file of presentation.files) addFileTag(transcript, block, tags, file);
  for (const [index, image] of presentation.images.entries()) {
    addImageTag(transcript, block, tags, image, index + 1);
  }
}

/** A short one-line note: session info, command output, errors. */
export function appendNote(
  transcript: Transcript,
  text: string,
  color?: string,
  parent?: Renderable,
  before?: Renderable,
): BoxRenderable {
  const box = section(transcript, "note", {}, parent, before);
  box.add(
    new TextRenderable(transcript.renderer, {
      id: transcript.nextId("note-text"),
      content: text,
      fg: color ?? transcript.theme.dim,
      wrapMode: "word",
    }),
  );
  return box;
}

/** Temporary queue feedback which disappears once core consumes or cancels the steer. */
export class PendingSteeringStatus {
  private readonly transcript: Transcript;
  private pending = new Set<string>();
  private readonly notes = new Map<string, BoxRenderable>();

  constructor(transcript: Transcript) {
    this.transcript = transcript;
  }

  sync(entryIds: readonly string[]): void {
    this.pending = new Set(entryIds);
    for (const entryId of this.notes.keys()) {
      if (!this.pending.has(entryId)) this.remove(entryId);
    }
  }

  show(entryId: string, text: string): void {
    if (!this.pending.has(entryId)) return;
    this.remove(entryId);
    this.notes.set(entryId, appendNote(this.transcript, `Steering: ${text}`));
  }

  resolve(entryId: string): void {
    this.pending.delete(entryId);
    this.remove(entryId);
  }

  clear(): void {
    this.pending.clear();
    for (const entryId of this.notes.keys()) this.remove(entryId);
  }

  private remove(entryId: string): void {
    const note = this.notes.get(entryId);
    if (note === undefined) return;
    this.notes.delete(entryId);
    note.parent?.remove(note);
    if (!note.isDestroyed) note.destroyRecursively();
  }
}

/** A restored compaction checkpoint, kept dim so old context reads as history. */
export function appendCompaction(
  transcript: Transcript,
  summary: string,
  tokensBefore: number,
  parent: Renderable = transcript.container,
  before?: Renderable,
): void {
  const { theme } = transcript;
  const preview = previewLines(summary, 40);
  const visibleSummary =
    preview.omitted === 0 ? preview.text : `${preview.text}\n${omittedLabel(preview.omitted)}`;
  const card = new BoxRenderable(transcript.renderer, {
    id: transcript.nextId("compaction"),
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.promptBorder,
    paddingLeft: 2,
    paddingRight: 2,
    marginTop: SPACING.block,
    width: "100%",
  });
  card.add(
    new TextRenderable(transcript.renderer, {
      id: transcript.nextId("compaction-heading"),
      content: new StyledText([
        fg(theme.dim)(`context compacted · ${String(tokensBefore)} tokens before`),
      ]),
      wrapMode: "word",
    }),
  );
  if (visibleSummary !== "") {
    card.add(
      new TextRenderable(transcript.renderer, {
        id: transcript.nextId("compaction-summary"),
        content: visibleSummary,
        fg: theme.dim,
        wrapMode: "word",
      }),
    );
  }
  if (before === undefined) parent.add(card);
  else parent.insertBefore(card, before);
}

export function authUrlText(url: string, color: string, prefix = ""): StyledText {
  const linkedUrl = link(url)(fg(color)(url));
  return new StyledText(prefix === "" ? [linkedUrl] : [fg(color)(prefix), linkedUrl]);
}

/** Keep the auth URL complete, open a click, and leave a drag available for selection. */
export function appendAuthUrl(
  transcript: Transcript,
  { url, openUrl, prefix = "" }: { url: string; openUrl: (url: string) => void; prefix?: string },
): TextRenderable {
  let pressedAt: { x: number; y: number } | undefined;
  const text = new TextRenderable(transcript.renderer, {
    id: transcript.nextId("auth-url"),
    content: authUrlText(url, transcript.theme.user, prefix),
    wrapMode: "char",
    onMouseDown(event) {
      if (event.button === 0) pressedAt = { x: event.x, y: event.y };
    },
    onMouseUp(event) {
      const clicked = event.button === 0 && pressedAt?.x === event.x && pressedAt.y === event.y;
      pressedAt = undefined;
      if (!clicked) return;
      event.preventDefault();
      event.stopPropagation();
      transcript.renderer.clearSelection();
      openUrl(url);
    },
  });
  transcript.container.add(text);
  return text;
}

/** Top-level turn owner; animation stays here because nested live boxes break layout. */
class TurnSection extends BoxRenderable {
  private readonly animations = new Map<
    symbol,
    { elapsed: number; line: TextRenderable; draw: (elapsedMs: number) => StyledText }
  >();

  constructor(transcript: Transcript) {
    super(transcript.renderer, {
      id: transcript.nextId("turn"),
      flexDirection: "column",
      paddingLeft: 0,
      paddingRight: 0,
      marginTop: SPACING.block,
      width: "100%",
      live: false,
    });
    transcript.container.add(this);
  }

  protected override onUpdate(deltaTime: number): void {
    for (const animation of this.animations.values()) {
      animation.elapsed += deltaTime;
      animation.line.content = animation.draw(animation.elapsed);
    }
  }

  animate(line: TextRenderable, draw: (elapsedMs: number) => StyledText): symbol {
    const id = Symbol("turn-animation");
    line.content = draw(0);
    this.animations.set(id, { elapsed: 0, line, draw });
    this.live = true;
    return id;
  }

  changeAnimation(id: symbol, draw: (elapsedMs: number) => StyledText): void {
    const animation = this.animations.get(id);
    if (animation === undefined) return;
    animation.draw = draw;
    animation.line.content = draw(animation.elapsed);
  }

  stopAnimation(id: symbol): number {
    const elapsed = this.animations.get(id)?.elapsed ?? 0;
    this.animations.delete(id);
    if (this.animations.size === 0) this.live = false;
    return elapsed;
  }
}

/** Streamed assistant markdown owned by one conversation turn. */
class AssistantPartBlock {
  private readonly box: BoxRenderable;
  private readonly markdown: MarkdownRenderable;
  private readonly renderer: CliRenderer;
  private buffer = "";
  private settled = false;
  private renderedWidth = 0;

  constructor(
    transcript: Transcript,
    parent: Renderable,
    initial = "",
    streaming = true,
    before?: Renderable,
  ) {
    this.box = section(transcript, "assistant", {}, parent, before);
    this.buffer = initial;
    this.renderer = transcript.renderer;
    this.markdown = new MarkdownRenderable(transcript.renderer, {
      id: transcript.nextId("assistant-md"),
      content: initial,
      syntaxStyle: transcript.syntaxStyle,
      streaming,
      internalBlockMode: "top-level",
    });
    this.markdown.onSizeChange = () => {
      if (this.settled) this.renderDiagram();
    };
    this.box.add(this.markdown);
    this.showWhenFilled();
  }

  append(delta: string): void {
    this.buffer += delta;
    this.showWhenFilled();
    if (!hasIncompleteHeadingPrefix(this.buffer)) this.markdown.content = this.buffer;
  }

  set(text: string): void {
    this.buffer = text;
    this.showWhenFilled();
    this.renderDiagram(true);
  }

  /**
   * Mermaid fences become drawings only once the turn settles: a half-streamed
   * fence has no shape yet, and redrawing one per delta would flicker.
   */
  finish(): void {
    this.settled = true;
    this.showWhenFilled();
    this.renderDiagram(true);
    this.markdown.streaming = false;
  }

  /**
   * A part that carries only whitespace draws nothing but would still claim
   * its block margin, which breaks the one-blank-row rhythm between blocks.
   * Hidden boxes leave the flex layout, so the gap stays even.
   */
  private showWhenFilled(): void {
    this.box.visible = this.buffer.trim() !== "";
  }

  private renderDiagram(force = false): void {
    const width = this.contentWidth();
    if (!force && width === this.renderedWidth) return;
    this.renderedWidth = width;
    this.markdown.content = renderDiagramFences(this.buffer, width);
  }

  private contentWidth(): number {
    return Math.max(1, this.markdown.width || this.renderer.width - 4);
  }
}

/** The turn's single live status row. It never competes with another spinner. */
class ActivityBlock {
  private readonly transcript: Transcript;
  private readonly owner: TurnSection;
  private readonly section: BoxRenderable;
  private readonly line: TextRenderable;
  private readonly animation: symbol;
  private mode: "working" | "thinking" | "settled" = "working";

  get anchor(): Renderable {
    return this.section;
  }

  constructor(transcript: Transcript, parent: TurnSection) {
    this.transcript = transcript;
    this.owner = parent;
    this.section = section(transcript, "activity", {}, parent);
    this.line = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("activity-line"),
      content: "",
      wrapMode: "none",
    });
    this.section.add(this.line);
    this.animation = parent.animate(this.line, this.workingFrame);
  }

  beginThinking(): void {
    if (this.mode !== "working") return;
    const { theme } = this.transcript;
    this.mode = "thinking";
    this.owner.changeAnimation(
      this.animation,
      (elapsed) =>
        new StyledText([
          fg(theme.thinking)(spinnerFrame(elapsed)),
          fg(theme.thinking)(ACTIVITY_THINKING_LABEL),
        ]),
    );
  }

  endThinking(): void {
    if (this.mode !== "thinking") return;
    this.mode = "working";
    this.owner.changeAnimation(this.animation, this.workingFrame);
  }

  settle(outcome: "completed" | "aborted" | "failed"): void {
    const { theme } = this.transcript;
    const elapsed = this.owner.stopAnimation(this.animation);
    this.mode = "settled";
    if (outcome === "completed") {
      const duration = elapsed > 0 ? ` for ${formatDuration(elapsed)}` : "";
      this.line.content = new StyledText([fg(theme.dim)(`${ACTIVITY_WORKED_LABEL}${duration}`)]);
    } else if (outcome === "aborted") {
      this.line.content = new StyledText([fg(theme.warning)(ACTIVITY_STOPPED_LABEL)]);
    } else {
      this.line.content = new StyledText([
        fg(theme.error)(`${GLYPHS.cross}${ACTIVITY_FAILED_LABEL}`),
      ]);
    }
  }

  private readonly workingFrame = (elapsed: number): StyledText =>
    new StyledText([
      fg(this.transcript.theme.running)(spinnerFrame(elapsed)),
      fg(this.transcript.theme.dim)(ACTIVITY_WORKING_LABEL),
    ]);
}

/** Streamed reasoning content that settles to a static Thought block. */
class ReasoningBlock {
  private readonly box: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly markdown: MarkdownRenderable;
  private buffer = "";
  private finished = false;

  constructor(transcript: Transcript, parent: TurnSection, before: Renderable) {
    this.box = section(transcript, "thinking", {}, parent, before);
    this.box.visible = false;
    this.heading = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("thinking-heading"),
      content: "",
      visible: false,
      wrapMode: "none",
    });
    this.markdown = new MarkdownRenderable(transcript.renderer, {
      id: transcript.nextId("thinking-md"),
      content: "",
      syntaxStyle: transcript.subtleSyntaxStyle,
      streaming: true,
      internalBlockMode: "top-level",
      fg: transcript.theme.dim,
    });
    this.box.add(this.heading);
    this.box.add(this.markdown);
  }

  append(delta: string): void {
    this.buffer += delta;
    this.showWhenFilled();
    const content = this.preview();
    if (!hasIncompleteHeadingPrefix(content)) this.markdown.content = content;
  }

  set(text: string): void {
    this.buffer = text;
    this.showWhenFilled();
    this.markdown.content = this.preview();
  }

  /** A blank thought earns neither a heading nor the row its block would take. */
  finish(theme: CliTheme): void {
    if (this.finished) return;
    this.finished = true;
    this.showWhenFilled();
    this.heading.content = new StyledText([
      fg(theme.thinking)(`${GLYPHS.diamond}${ACTIVITY_THOUGHT_LABEL}`),
    ]);
    this.heading.visible = this.box.visible;
    this.markdown.content = this.preview();
    this.markdown.streaming = false;
  }

  private showWhenFilled(): void {
    this.box.visible = this.buffer.trim() !== "";
  }

  private preview(): string {
    const preview = previewLines(this.buffer, RESULT_PREVIEW_LINES, RESULT_TAIL_LINES);
    return preview.omitted === 0
      ? preview.text
      : `${preview.text}\n${omittedLabel(preview.omitted)}`;
  }
}

/**
 * One card per tool call, reused from start through partial updates and the
 * final result. Unified diffs from edit details or shell output render with
 * DiffRenderable; everything else shows a capped source-aware preview.
 */
export class ToolCard {
  private readonly transcript: Transcript;
  private readonly detail: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly call: ToolCallSummary;
  private readonly structuredBodies: Renderable[] = [];
  private textBody: CodeRenderable | undefined;
  private omitted: TextRenderable | undefined;

  private operandColor(): string {
    const { theme } = this.transcript;
    switch (this.call.operandKind) {
      case "path":
        return theme.path;
      case "pattern":
        return theme.string;
      case "command":
        return theme.command;
      default:
        return theme.foreground;
    }
  }

  private headingContent(icon: string, color: string, result?: string): StyledText {
    const { theme } = this.transcript;
    const operand =
      this.call.operandKind === "path"
        ? relativePath(this.call.operand, this.transcript.cwd ?? "")
        : this.call.operand;
    const chunks = [
      fg(color)(icon),
      fg(theme.foreground)(` ${this.call.verb}`),
      fg(this.operandColor())(operand === "" ? "" : ` ${operand}`),
    ];
    if (this.call.qualifier !== undefined && this.call.qualifier !== "") {
      chunks.push(fg(theme.dim)(` ${this.call.qualifier}`));
    }
    if (result !== undefined) chunks.push(fg(theme.dim)(`  ${result}`));
    return new StyledText(chunks);
  }

  constructor(
    transcript: Transcript,
    toolName: string,
    args: unknown,
    parent: Renderable = transcript.container,
    before?: Renderable,
  ) {
    this.transcript = transcript;
    this.call = describeToolCall(toolName, args);
    const box = section(transcript, "tool", {}, parent, before);
    this.heading = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("tool-heading"),
      content: this.headingContent(GLYPHS.bullet, transcript.theme.running),
      wrapMode: "none",
      truncate: true,
    });
    box.add(this.heading);
    this.detail = new BoxRenderable(transcript.renderer, {
      id: transcript.nextId("tool-detail"),
      visible: false,
      flexDirection: "column",
      backgroundColor: transcript.theme.codeBackground,
      paddingLeft: 2,
      maxHeight: DIFF_PREVIEW_LINES,
      overflow: "hidden",
      width: "100%",
    });
    box.add(this.detail);
    if (this.call.body !== undefined) this.showPreview(this.call.body, transcript.theme.dim);
  }

  update(text: string): void {
    const inline = inlineToolPreview(text);
    this.heading.content = this.headingContent(
      GLYPHS.bullet,
      this.transcript.theme.user,
      inline ?? resultSummary(text),
    );
    if (inline === undefined) this.showPreview(text, this.transcript.theme.dim);
    else this.clearBody();
  }

  complete(text: string, options: { isError?: boolean; details?: unknown } = {}): void {
    const { theme } = this.transcript;
    const isError = options.isError ?? false;
    const detailsDiff = diffFromDetails(options.details);
    const outputDiff = detailsDiff === undefined ? diffFromOutput(text) : undefined;
    const presentedDiff =
      detailsDiff === undefined
        ? outputDiff
        : {
            files: [
              {
                patch: detailsDiff,
                ...(this.call.path === undefined ? {} : { path: this.call.path }),
              },
            ],
          };
    if (presentedDiff !== undefined && !isError) {
      const stat = diffStat(presentedDiff.files.map((file) => file.patch).join("\n"));
      this.heading.content = this.headingContent(
        GLYPHS.check,
        theme.ok,
        `+${String(stat.added)} -${String(stat.removed)}`,
      );
      this.showDiff(presentedDiff);
      return;
    }
    const inline = inlineToolPreview(text);
    this.heading.content = this.headingContent(
      isError ? GLYPHS.cross : GLYPHS.check,
      isError ? theme.error : theme.ok,
      inline ?? resultSummary(text),
    );
    // The model asked to read the file; the reader did not. Its size is enough.
    if (this.call.verb === "Read" && !isError) this.clearBody();
    else if (inline === undefined) this.showPreview(text, isError ? theme.error : theme.dim);
    else this.clearBody();
  }

  private showPreview(text: string, color: string): void {
    const preview = previewLines(text, RESULT_PREVIEW_LINES, RESULT_TAIL_LINES);
    if (this.structuredBodies.length > 0) this.clearBody();
    if (preview.text === "") {
      this.clearBody();
      return;
    }
    this.detail.visible = true;
    this.detail.paddingLeft = 2;
    if (this.textBody === undefined) {
      this.textBody = new CodeRenderable(this.transcript.renderer, {
        id: this.transcript.nextId("tool-body"),
        content: preview.text,
        filetype: this.call.path === undefined ? undefined : pathToFiletype(this.call.path),
        syntaxStyle: this.transcript.syntaxStyle,
        onChunks: shikiChunks(this.transcript.theme),
        conceal: false,
        fg: color,
        bg: this.transcript.theme.codeBackground,
        wrapMode: "none",
        truncate: true,
        selectionBg: this.transcript.theme.selectionBackground,
        selectionFg: this.transcript.theme.selectionForeground,
        width: "100%",
      });
      this.detail.add(this.textBody);
    } else {
      this.textBody.content = preview.text;
      this.textBody.fg = color;
    }
    if (this.omitted !== undefined) {
      this.detail.remove(this.omitted);
      this.omitted.destroy();
      this.omitted = undefined;
    }
    if (preview.omitted > 0) {
      this.omitted = label(
        this.transcript,
        omittedLabel(preview.omitted),
        this.transcript.theme.dim,
      );
      this.detail.add(this.omitted);
    }
  }

  private showDiff(output: OutputDiff): void {
    this.clearBody();
    this.detail.visible = true;
    this.detail.paddingLeft = 0;
    if (output.before !== undefined) this.addSupplementalPreview(output.before);
    for (const file of output.files) {
      const diff = new DiffRenderable(this.transcript.renderer, {
        id: this.transcript.nextId("tool-diff"),
        diff: file.patch,
        view: "unified",
        showLineNumbers: true,
        filetype: file.path === undefined ? undefined : pathToFiletype(file.path),
        syntaxStyle: this.transcript.syntaxStyle,
        wrapMode: "none",
        addedBg: this.transcript.theme.diffAddedBackground,
        removedBg: this.transcript.theme.diffRemovedBackground,
        addedLineNumberBg: this.transcript.theme.diffAddedBackground,
        removedLineNumberBg: this.transcript.theme.diffRemovedBackground,
        addedSignColor: this.transcript.theme.ok,
        removedSignColor: this.transcript.theme.error,
        lineNumberFg: this.transcript.theme.dim,
        selectionBg: this.transcript.theme.selectionBackground,
        selectionFg: this.transcript.theme.selectionForeground,
        width: "100%",
      });
      applyShikiToCodeChildren(diff, this.transcript.theme);
      clipOffscreenDiffLineColors(diff);
      this.detail.add(diff);
      this.structuredBodies.push(diff);
    }
    if (output.after !== undefined) this.addSupplementalPreview(output.after);
  }

  private addSupplementalPreview(text: string): void {
    const preview = previewLines(text, RESULT_PREVIEW_LINES, RESULT_TAIL_LINES);
    if (preview.text === "") return;
    const panel = new BoxRenderable(this.transcript.renderer, {
      id: this.transcript.nextId("tool-output"),
      flexDirection: "column",
      paddingLeft: 2,
      width: "100%",
    });
    panel.add(
      new CodeRenderable(this.transcript.renderer, {
        id: this.transcript.nextId("tool-output-body"),
        content: preview.text,
        syntaxStyle: this.transcript.syntaxStyle,
        conceal: false,
        fg: this.transcript.theme.dim,
        bg: this.transcript.theme.codeBackground,
        wrapMode: "none",
        truncate: true,
        selectionBg: this.transcript.theme.selectionBackground,
        selectionFg: this.transcript.theme.selectionForeground,
        width: "100%",
      }),
    );
    if (preview.omitted > 0) {
      panel.add(label(this.transcript, omittedLabel(preview.omitted), this.transcript.theme.dim));
    }
    this.detail.add(panel);
    this.structuredBodies.push(panel);
  }

  private clearBody(): void {
    if (this.textBody !== undefined) {
      this.detail.remove(this.textBody);
      this.textBody.destroy();
      this.textBody = undefined;
    }
    for (const body of this.structuredBodies.splice(0)) {
      this.detail.remove(body);
      body.destroyRecursively();
    }
    if (this.omitted !== undefined) {
      this.detail.remove(this.omitted);
      this.omitted.destroy();
      this.omitted = undefined;
    }
    this.detail.visible = false;
    this.detail.paddingLeft = 2;
  }
}

/** One visual owner for a user request and every assistant step it drives. */
export class ConversationTurnBlock {
  private readonly transcript: Transcript;
  private readonly root: TurnSection;
  private readonly reasoning = new Map<string, ReasoningBlock>();
  private readonly assistants = new Map<string, AssistantPartBlock>();
  private readonly tools = new Map<string, ToolCard>();
  private activity: ActivityBlock | undefined;
  private step = 0;
  private outcome: "completed" | "aborted" | "failed" = "completed";

  constructor(transcript: Transcript, outcome: "completed" | "aborted" | "failed" = "completed") {
    this.transcript = transcript;
    this.outcome = outcome;
    this.root = new TurnSection(transcript);
  }

  nextStep(): void {
    this.step += 1;
  }

  addUser(content: UserMessage["content"]): void {
    appendUser(this.transcript, content, this.root);
    this.ensureWorking();
  }

  updateAssistant(event: AssistantMessageEvent): void {
    if (event.type === "start" || event.type === "done" || event.type === "error") return;
    const key = this.partKey(event.contentIndex);
    switch (event.type) {
      case "thinking_start": {
        break;
      }
      case "thinking_delta": {
        this.reasoningBlock(key).append(event.delta);
        break;
      }
      case "thinking_end": {
        if (event.content === "" && !this.reasoning.has(key)) break;
        const block = this.reasoningBlock(key);
        block.set(event.content);
        block.finish(this.transcript.theme);
        this.activity?.endThinking();
        break;
      }
      case "text_start": {
        break;
      }
      case "text_delta": {
        this.assistantBlock(key).append(event.delta);
        break;
      }
      case "text_end": {
        if (event.content === "" && !this.assistants.has(key)) break;
        const block = this.assistantBlock(key);
        block.set(event.content);
        block.finish();
        break;
      }
      case "toolcall_end": {
        const before = this.contentAnchor();
        this.tools.set(
          event.toolCall.id,
          new ToolCard(
            this.transcript,
            event.toolCall.name,
            event.toolCall.arguments,
            this.root,
            before,
          ),
        );
        break;
      }
      case "toolcall_start":
      case "toolcall_delta":
        break;
    }
  }

  finishAssistant(message: AssistantMessage): void {
    let hasToolCall = false;
    for (const [contentIndex, part] of message.content.entries()) {
      const key = this.partKey(contentIndex);
      if (part.type === "thinking") {
        if (part.thinking === "") continue;
        const block = this.reasoningBlock(key);
        block.set(part.thinking);
        block.finish(this.transcript.theme);
        this.activity?.endThinking();
      } else if (part.type === "text") {
        if (part.text === "") continue;
        const block = this.assistantBlock(key);
        block.set(part.text);
        block.finish();
      } else {
        hasToolCall = true;
        if (!this.tools.has(part.id)) {
          const before = this.contentAnchor();
          this.tools.set(
            part.id,
            new ToolCard(this.transcript, part.name, part.arguments, this.root, before),
          );
        }
      }
    }
    if (!hasToolCall) this.ensureWorking();
    if (message.stopReason === "aborted") this.outcome = "aborted";
    else if (message.stopReason === "error" || message.errorMessage !== undefined) {
      this.outcome = "failed";
    }
  }

  startTool(callId: string, toolName: string, args: unknown): void {
    if (!this.tools.has(callId)) {
      this.tools.set(
        callId,
        new ToolCard(this.transcript, toolName, args, this.root, this.contentAnchor()),
      );
    }
  }

  updateTool(callId: string, text: string): void {
    this.tools.get(callId)?.update(text);
  }

  finishTool(
    callId: string,
    toolName: string,
    text: string,
    options: { isError?: boolean; details?: unknown } = {},
  ): void {
    let card = this.tools.get(callId);
    if (card === undefined) {
      card = new ToolCard(this.transcript, toolName, undefined, this.root, this.contentAnchor());
      this.tools.set(callId, card);
    }
    card.complete(text, options);
  }

  addStoredPart(part: TurnPart): void {
    switch (part.kind) {
      case "user":
        this.addUser(part.content);
        break;
      case "thinking": {
        const block = new ReasoningBlock(this.transcript, this.root, this.contentAnchor());
        block.set(part.text);
        block.finish(this.transcript.theme);
        break;
      }
      case "assistant":
        new AssistantPartBlock(
          this.transcript,
          this.root,
          part.text,
          false,
          this.contentAnchor(),
        ).finish();
        break;
      case "tool": {
        const card = new ToolCard(
          this.transcript,
          part.toolName,
          part.args,
          this.root,
          this.contentAnchor(),
        );
        this.tools.set(part.callId, card);
        if (part.result !== undefined) {
          card.complete(part.result.output, {
            isError: part.result.isError,
            details: part.result.details,
          });
        }
        break;
      }
      case "note":
        appendNote(this.transcript, part.text, undefined, this.root, this.contentAnchor());
        break;
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  addNote(text: string, color?: string): void {
    appendNote(this.transcript, text, color, this.root, this.contentAnchor());
  }

  addCompaction(summary: string, tokensBefore: number): void {
    appendCompaction(this.transcript, summary, tokensBefore, this.root, this.contentAnchor());
  }

  settle(outcome = this.outcome): void {
    for (const block of this.reasoning.values()) block.finish(this.transcript.theme);
    for (const block of this.assistants.values()) block.finish();
    this.ensureWorking().settle(outcome);
    this.activity = undefined;
  }

  private partKey(contentIndex: number): string {
    return `${String(this.step)}:${String(contentIndex)}`;
  }

  private ensureWorking(): ActivityBlock {
    this.activity ??= new ActivityBlock(this.transcript, this.root);
    return this.activity;
  }

  private contentAnchor(): Renderable {
    return this.ensureWorking().anchor;
  }

  private reasoningBlock(key: string): ReasoningBlock {
    const existing = this.reasoning.get(key);
    if (existing !== undefined) return existing;
    const activity = this.ensureWorking();
    const block = new ReasoningBlock(this.transcript, this.root, activity.anchor);
    activity.beginThinking();
    this.reasoning.set(key, block);
    return block;
  }

  private assistantBlock(key: string): AssistantPartBlock {
    const existing = this.assistants.get(key);
    if (existing !== undefined) return existing;
    const block = new AssistantPartBlock(
      this.transcript,
      this.root,
      "",
      true,
      this.contentAnchor(),
    );
    this.assistants.set(key, block);
    return block;
  }
}

/** Render restored turns with the same owner the live path uses. */
export function renderItems(
  transcript: Transcript,
  items: readonly Turn[],
  options: { openLastTurn?: boolean } = {},
): ConversationTurnBlock | undefined {
  let lastTurnIndex = -1;
  if (options.openLastTurn === true) {
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "turn") {
        lastTurnIndex = index;
        break;
      }
    }
  }
  let openTurn: ConversationTurnBlock | undefined;
  for (const [index, item] of items.entries()) {
    switch (item.kind) {
      case "turn": {
        const turn = new ConversationTurnBlock(transcript, item.outcome);
        for (const part of item.parts) turn.addStoredPart(part);
        if (index === lastTurnIndex) openTurn = turn;
        else turn.settle(item.outcome);
        break;
      }
      case "compaction":
        appendCompaction(transcript, item.entry.summary, item.entry.tokensBefore);
        break;
      case "model_change":
      case "custom": {
        const text = entryNote(item.entry);
        if (text !== undefined) appendNote(transcript, text);
        break;
      }
      default: {
        const _exhaustive: never = item;
        return _exhaustive;
      }
    }
  }
  return openTurn;
}

/**
 * The line an entry draws on its own. A client that claims an entry before it
 * reaches the session draws the same text a reload would have produced.
 */
export function entryNote(entry: ProvisionedEntry): string | undefined {
  if (entry.type === "model_change") return `Model → ${entry.modelId}`;
  if (entry.type === "custom") return customEntryNote(entry);
  return undefined;
}

function customEntryNote(entry: ProvisionedEntry<CustomEntry>): string | undefined {
  const { data } = entry;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  if (
    entry.customType === "provider_change" &&
    "providerId" in data &&
    typeof data.providerId === "string"
  ) {
    return `Provider → ${data.providerId}`;
  }
  if (entry.customType === "cwd_change" && "cwd" in data && typeof data.cwd === "string") {
    return `Directory → ${data.cwd}`;
  }
  return undefined;
}
