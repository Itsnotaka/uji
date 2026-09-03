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
  RenderableEvents,
  StyledText,
  SyntaxStyle,
  TextRenderable,
} from "@opentui/core";
import type {
  BoxOptions,
  CliRenderer,
  LineColorConfig,
  OnChunksCallback,
  Renderable,
} from "@opentui/core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  JsonValue,
  UserMessage,
} from "@uji-ai/schema";
import { patchOf } from "@uji-ai/core";
import type { Turn, TurnOutcome, TurnPart } from "@uji-ai/core";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractFileAttachments,
  extractFileMentions,
  PASTE_COLLAPSE_LINES,
  pasteLineCount,
} from "./composer.ts";
import { renderDiagramFences } from "./diagram.ts";
import { extractSkillInvocations } from "./slash.ts";
import {
  patchPath,
  toolHeading,
  diffFromOutput,
  diffSections,
  diffStat,
  earlierCallsLabel,
  formatDuration,
  omittedLabel,
  previewLines,
  resultSummary,
  spinnerFrame,
  toolCallCounts,
  toolCallVerbs,
  unchangedLinesLabel,
  type OutputDiff,
} from "./format.ts";
import {
  ACTIVITY_FAILED_LABEL,
  ACTIVITY_STOPPED_LABEL,
  ACTIVITY_THINKING_LABEL,
  ACTIVITY_THOUGHT_LABEL,
  ACTIVITY_WORKED_LABEL,
  ACTIVITY_WORKING_LABEL,
  GLYPHS,
  GROUP_TAIL_CALLS,
  keycap,
  MIN_REPORTED_DURATION_MS,
  RESULT_PREVIEW_LINES,
  RESULT_TAIL_LINES,
  SPACING,
  TOOL_INLINE_PREVIEW_LENGTH,
} from "./constants.ts";
import type { ToolCallDisplay } from "./constants.ts";
import { presenter } from "./presenters.ts";
import type { CliTheme } from "./theme.ts";
import { displayWidth } from "./width.ts";
import { collapsedImagePreview, collapsedTag } from "./collapsed-tag.ts";
import { syntaxHighlightedChunks } from "./highlight.ts";
import { bindSemantics } from "./semantics.ts";
import type { CustomEntry, ProvisionedEntry } from "@uji-ai/core/store";

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

/**
 * Keep code columns fixed when separate hunks have different line-number widths.
 * Based on OpenCode's patch diff component:
 * https://github.com/anomalyco/opencode/blob/v2/packages/tui/src/component/patch-diff.tsx
 */
function syncDiffGutters(diffs: readonly DiffRenderable[]): void {
  const gutters = diffs.flatMap((diff) =>
    diff.getChildren().filter((child) => child instanceof LineNumberRenderable),
  );
  const numbers = gutters.map((gutter) => new Map(gutter.getLineNumbers()));
  const digits = numbers.map((lines) => Math.max(0, ...lines.values()).toString().length);
  const after = gutters.map((gutter) =>
    Math.max(
      0,
      ...[...gutter.getLineSigns().values()].map((sign) => displayWidth(sign.after ?? "")),
    ),
  );
  const maxDigits = Math.max(0, ...digits);
  const maxAfter = Math.max(0, ...after);
  for (const [index, gutter] of gutters.entries()) {
    const lineNumbers = numbers[index];
    const lineDigits = digits[index];
    if (lineNumbers === undefined || lineDigits === undefined) continue;
    const signs = new Map(gutter.getLineSigns());
    signs.set(-1, { after: " ".repeat(maxAfter + maxDigits - lineDigits) });
    gutter.setLineNumbers(lineNumbers);
    gutter.setLineSigns(signs);
  }
}

function inlineToolPreview(text: string): string | undefined {
  const value = text.trim();
  if (value === "" || value.includes("\n") || displayWidth(value) > TOOL_INLINE_PREVIEW_LENGTH) {
    return undefined;
  }
  return value;
}

function toolOutputPreview(text: string, expanded: boolean): ReturnType<typeof previewLines> {
  const trimmed = text.replace(/\n+$/u, "");
  if (expanded || trimmed === "") return { text: trimmed, omitted: 0 };

  const preview = previewLines(text, RESULT_PREVIEW_LINES, RESULT_TAIL_LINES);
  const hidden = Math.max(0, trimmed.split("\n").length - RESULT_PREVIEW_LINES - RESULT_TAIL_LINES);
  if (hidden === 0) return preview;
  const omission = omittedLabel(hidden);
  return {
    ...preview,
    text: preview.text.replace(omission, `${omission} · ${keycap("chat.tools.toggle")} expand`),
  };
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

interface ExpandableToolOutput {
  setExpanded(expanded: boolean): void;
}

/**
 * One expansion state for the transcript and every tool card in it. New cards
 * inherit the state, while destroyed cards unregister themselves.
 *
 * Based on pi's global tool-output toggle:
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts
 */
export class ToolOutputExpansion {
  private readonly cards = new Set<ExpandableToolOutput>();
  private current = false;

  get expanded(): boolean {
    return this.current;
  }

  register(card: ExpandableToolOutput): () => void {
    this.cards.add(card);
    card.setExpanded(this.current);
    return () => this.cards.delete(card);
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.current) return;
    this.current = expanded;
    for (const card of this.cards) card.setExpanded(expanded);
  }

  toggle(): boolean {
    this.setExpanded(!this.current);
    return this.current;
  }
}

export interface Transcript {
  renderer: CliRenderer;
  container: Renderable;
  syntaxStyle: SyntaxStyle;
  subtleSyntaxStyle: SyntaxStyle;
  theme: CliTheme;
  toolOutput: ToolOutputExpansion;
  /** How consecutive tool calls are drawn. Settings own the value. */
  toolCalls: ToolCallDisplay;
  /** Working directory of the harness whose entries are being rendered. */
  cwd?: string;
  nextId: (prefix?: string) => string;
  openPath?: (path: string) => void;
  /** Keeps nested user cards at the visible transcript width. */
  userLayout?: {
    readonly blocks: Set<BoxRenderable>;
    width(): number;
  };
}

type SectionOptions = Pick<
  BoxOptions,
  | "backgroundColor"
  | "marginTop"
  | "marginLeft"
  | "marginRight"
  | "paddingTop"
  | "paddingBottom"
  | "paddingLeft"
  | "paddingRight"
  | "width"
>;

function section(
  transcript: Transcript,
  prefix: string,
  options: SectionOptions = {},
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
    marginLeft: options.marginLeft ?? 0,
    marginRight: options.marginRight ?? 0,
    width: options.width ?? "100%",
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

/** A skill the turn invoked, shown as the token that invoked it. */
interface PresentedSkill {
  name: string;
  path: string;
}

function userPresentation(content: UserMessage["content"]) {
  let text =
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  // An attached body is the file, not the prompt. It folds back into its tag so
  // the turn reads as what the user typed, and the tag can open it on demand.
  // Instructions the prompt pulled in are the skill, not the prompt: they fold
  // to the same short token the composer showed while the message was drafted.
  const skills: PresentedSkill[] = [];
  for (const invocation of extractSkillInvocations(text)) {
    skills.push({ name: invocation.name, path: invocation.path });
    text = text.replace(invocation.source, "");
  }
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
    skills,
    images,
  };
}

/** Lines kept visible when a user message is folded. */
const PASTE_PREVIEW_LINES = 3;

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
    content: folded ? preview : text,
    fg: transcript.theme.foreground,
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
      body.content = expanded ? text : preview;
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

/** A skill the turn invoked. The tag opens its SKILL.md, the way a file tag does. */
function addSkillTag(transcript: Transcript, tags: BoxRenderable, skill: PresentedSkill): void {
  collapsedTag(transcript, tags, {
    id: "skill-tag",
    url: pathToFileURL(skill.path).href,
    label: () => ` Skill ${skill.name} `,
    onToggle: () => transcript.openPath?.(skill.path),
  });
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
): BoxRenderable {
  const presentation = userPresentation(content);
  const userLayout = transcript.userLayout;
  const block = section(
    transcript,
    "user",
    {
      backgroundColor: transcript.theme.userBackground,
      marginTop: parent === undefined ? SPACING.block : 0,
      marginLeft: 1,
      marginRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 3,
      width: userLayout?.width() ?? "100%",
    },
    parent,
  );
  if (userLayout !== undefined) {
    userLayout.blocks.add(block);
    block.once(RenderableEvents.DESTROYED, () => userLayout.blocks.delete(block));
  }
  if (presentation.text !== "") addUserText(transcript, block, presentation.text);

  const tags = new BoxRenderable(transcript.renderer, {
    id: transcript.nextId("user-attachments"),
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 1,
    visible:
      presentation.files.length + presentation.skills.length + presentation.images.length > 0,
    marginTop: presentation.text === "" ? 0 : 1,
  });
  block.add(tags);
  for (const skill of presentation.skills) addSkillTag(transcript, tags, skill);
  for (const file of presentation.files) addFileTag(transcript, block, tags, file);
  for (const [index, image] of presentation.images.entries()) {
    addImageTag(transcript, block, tags, image, index + 1);
  }
  return block;
}

/** A short one-line note: session info, command output, errors. */
function appendNote(
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

/** A compaction checkpoint, kept dim so old context reads as history. */
function appendCompaction(
  transcript: Transcript,
  summary: string,
  tokensBefore: number,
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
  transcript.container.add(card);
}

/** A branch summary left at a fork: what the abandoned branch was about. */
function appendBranchSummary(transcript: Transcript, summary: string, fromId: string): void {
  const { theme } = transcript;
  const preview = previewLines(summary, 40);
  const visibleSummary =
    preview.omitted === 0 ? preview.text : `${preview.text}\n${omittedLabel(preview.omitted)}`;
  const card = new BoxRenderable(transcript.renderer, {
    id: transcript.nextId("branch-summary"),
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
      id: transcript.nextId("branch-summary-heading"),
      content: new StyledText([fg(theme.dim)(`branch summary · from ${fromId.slice(0, 10)}`)]),
      wrapMode: "word",
    }),
  );
  if (visibleSummary !== "") {
    card.add(
      new TextRenderable(transcript.renderer, {
        id: transcript.nextId("branch-summary-text"),
        content: visibleSummary,
        fg: theme.dim,
        wrapMode: "word",
      }),
    );
  }
  transcript.container.add(card);
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

  constructor(transcript: Transcript, id?: string) {
    super(transcript.renderer, {
      id: id === undefined ? transcript.nextId("turn") : `turn:${id}`,
      flexDirection: "column",
      paddingLeft: 0,
      paddingRight: 0,
      marginTop: SPACING.block,
      width: "100%",
      live: false,
    });
    bindSemantics(this, () => ({ role: "message", id: id ?? this.id }));
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
  /** The turn's span as the record has it. The row's own clock runs on top. */
  private readonly durationMs: number;
  private mode: "working" | "thinking" | "settled" = "working";

  get anchor(): Renderable {
    return this.section;
  }

  constructor(transcript: Transcript, parent: TurnSection, durationMs = 0) {
    this.transcript = transcript;
    this.owner = parent;
    this.durationMs = durationMs;
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

  settle(outcome: TurnOutcome): void {
    const { theme } = this.transcript;
    const elapsed = this.durationMs + this.owner.stopAnimation(this.animation);
    this.mode = "settled";
    if (outcome === "completed") {
      const duration = elapsed >= MIN_REPORTED_DURATION_MS ? ` for ${formatDuration(elapsed)}` : "";
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

  constructor(transcript: Transcript, parent: TurnSection, before?: Renderable) {
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

type ToolCardPresentation =
  | { readonly kind: "called" }
  | { readonly kind: "streaming"; readonly text: string }
  | {
      readonly kind: "complete";
      readonly text: string;
      readonly isError: boolean;
      readonly details?: JsonValue;
    };

/**
 * One card per tool call, reused from start through partial updates and the
 * final result. Unified diffs from edit details or shell output render with
 * DiffRenderable; everything else shows a capped source-aware preview.
 */
export class ToolCard {
  readonly container: BoxRenderable;

  private readonly transcript: Transcript;
  private readonly detail: BoxRenderable;
  private readonly heading: TextRenderable;
  readonly toolName: string;
  private title: string | undefined;
  private readonly structuredBodies: Renderable[] = [];
  private presentation: ToolCardPresentation = { kind: "called" };
  private expanded = false;
  private compact = false;
  private textBody: CodeRenderable | undefined;
  private omitted: TextRenderable | undefined;
  private readonly onStateChange: () => void;

  private headingContent(icon: string, color: string, result?: string): StyledText {
    const { theme } = this.transcript;
    const chunks = [
      fg(color)(icon),
      fg(theme.foreground)(` ${toolHeading(this.toolName, this.title)}`),
    ];
    if (result !== undefined) chunks.push(fg(theme.dim)(`  ${result}`));
    return new StyledText(chunks);
  }

  constructor(
    transcript: Transcript,
    toolName: string,
    parent: Renderable = transcript.container,
    before?: Renderable,
    onStateChange: () => void = () => undefined,
  ) {
    this.transcript = transcript;
    this.toolName = toolName;
    this.onStateChange = onStateChange;
    this.container = section(transcript, "tool", {}, parent, before);
    this.heading = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("tool-heading"),
      content: this.headingContent(GLYPHS.bullet, transcript.theme.running),
      wrapMode: "none",
      truncate: true,
    });
    this.container.add(this.heading);
    this.detail = new BoxRenderable(transcript.renderer, {
      id: transcript.nextId("tool-detail"),
      visible: false,
      flexDirection: "column",
      backgroundColor: transcript.theme.codeBackground,
      paddingLeft: 2,
      width: "100%",
    });
    this.container.add(this.detail);
    const unregister = transcript.toolOutput.register(this);
    this.container.once(RenderableEvents.DESTROYED, unregister);
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.renderPresentation();
  }

  /** A collapsed group draws the card as one row: heading kept, body dropped. */
  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.renderPresentation();
  }

  /** The card has drawn its final result; a folded repeat has nothing to add. */
  get completed(): boolean {
    return this.presentation.kind === "complete";
  }

  get failed(): boolean {
    return this.presentation.kind === "complete" && this.presentation.isError;
  }

  update(text: string, title?: string): void {
    if (title !== undefined) this.title = title;
    this.presentation = { kind: "streaming", text };
    this.renderPresentation();
  }

  complete(
    text: string,
    options: { isError?: boolean; details?: JsonValue; title?: string } = {},
  ): void {
    if (options.title !== undefined) this.title = options.title;
    this.presentation = {
      kind: "complete",
      text,
      isError: options.isError ?? false,
      details: options.details,
    };
    this.renderPresentation();
    this.onStateChange();
  }

  private renderPresentation(): void {
    const { theme } = this.transcript;
    switch (this.presentation.kind) {
      case "called":
        this.heading.content = this.headingContent(GLYPHS.bullet, theme.running);
        this.clearBody();
        break;
      case "streaming": {
        const inline = inlineToolPreview(this.presentation.text);
        this.heading.content = this.headingContent(
          GLYPHS.bullet,
          theme.user,
          inline ?? resultSummary(this.presentation.text),
        );
        if (inline !== undefined || this.compact) this.clearBody();
        else this.showPreview(this.presentation.text, theme.dim);
        break;
      }
      case "complete":
        this.renderComplete(
          this.presentation.text,
          this.presentation.isError,
          this.presentation.details,
        );
        break;
      default: {
        const _exhaustive: never = this.presentation;
        return _exhaustive;
      }
    }
  }

  private renderComplete(text: string, isError: boolean, details: JsonValue | undefined): void {
    const { theme } = this.transcript;
    const detailsDiff = patchOf(details);
    const outputDiff = detailsDiff === undefined ? diffFromOutput(text) : undefined;
    const presentedDiff =
      detailsDiff === undefined
        ? outputDiff
        : { files: [{ patch: detailsDiff, path: patchPath(detailsDiff) }] };
    if (presentedDiff !== undefined && !isError) {
      const stat = diffStat(presentedDiff.files.map((file) => file.patch).join("\n"));
      this.heading.content = this.headingContent(
        GLYPHS.check,
        theme.ok,
        `+${String(stat.added)} -${String(stat.removed)}`,
      );
      if (this.compact) this.clearBody();
      else this.showDiff(presentedDiff);
      return;
    }
    const inline = inlineToolPreview(text);
    const refined = presenter.tool({
      toolName: this.toolName,
      result: {
        output: text,
        isError,
        ...(details === undefined ? {} : { details }),
        ...(this.title === undefined ? {} : { title: this.title }),
      },
    });
    const summary = refined.summary ?? inline ?? resultSummary(text);
    const collapsedRead =
      this.toolName === "read" && !isError && !this.expanded && inline === undefined;
    const headingResult =
      collapsedRead && !this.compact
        ? [summary, `${keycap("chat.tools.toggle")} expand`]
            .filter((value) => value !== undefined)
            .join(" · ")
        : summary;
    this.heading.content = this.headingContent(
      isError ? GLYPHS.cross : GLYPHS.check,
      isError ? theme.error : theme.ok,
      headingResult,
    );
    // A collapsed read names the file and its size without repeating its body.
    if (collapsedRead || this.compact) this.clearBody();
    else if (inline === undefined) this.showPreview(text, isError ? theme.error : theme.dim);
    else this.clearBody();
  }

  private showPreview(text: string, color: string): void {
    const preview = toolOutputPreview(text, this.expanded);
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
        filetype:
          this.toolName === "read" && this.title !== undefined
            ? pathToFiletype(this.title)
            : undefined,
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
    const diffs: DiffRenderable[] = [];
    for (const file of output.files) {
      for (const section of diffSections(file.patch)) {
        if (section.omittedBefore > 0) {
          const omitted = label(
            this.transcript,
            unchangedLinesLabel(section.omittedBefore),
            this.transcript.theme.dim,
          );
          this.detail.add(omitted);
          this.structuredBodies.push(omitted);
        }
        const diff = new DiffRenderable(this.transcript.renderer, {
          id: this.transcript.nextId("tool-diff"),
          diff: section.patch,
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
          minHeight: section.rows > 0 ? section.rows : undefined,
          width: "100%",
        });
        applyShikiToCodeChildren(diff, this.transcript.theme);
        clipOffscreenDiffLineColors(diff);
        this.detail.add(diff);
        this.structuredBodies.push(diff);
        diffs.push(diff);
      }
    }
    syncDiffGutters(diffs);
    if (output.after !== undefined) this.addSupplementalPreview(output.after);
  }

  private addSupplementalPreview(text: string): void {
    const preview = toolOutputPreview(text, this.expanded);
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

/** Tools whose card never folds into a group under the `auto` display mode. */
const DETAILED_TOOLS = new Set(["edit", "write"]);

/**
 * Consecutive tool calls collapse into one block: a verb heading, the newest
 * calls as single rows, and everything older behind an "earlier calls" count.
 * The window follows the stream, so the running call is always the visible
 * tail. Expanding restores every call as a full card.
 */
class ToolCallGroup implements ExpandableToolOutput {
  readonly container: BoxRenderable;

  private readonly transcript: Transcript;
  private readonly heading: TextRenderable;
  private readonly omitted: TextRenderable;
  private readonly body: BoxRenderable;
  private readonly cards: ToolCard[] = [];
  private expanded = false;

  constructor(transcript: Transcript, parent: Renderable, before?: Renderable) {
    this.transcript = transcript;
    this.container = section(
      transcript,
      "tool-group",
      { paddingLeft: 0, paddingRight: 0 },
      parent,
      before,
    );
    this.heading = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("tool-group-heading"),
      content: "",
      visible: false,
      marginLeft: SPACING.inset,
      wrapMode: "none",
      truncate: true,
      onMouseUp: (event) => {
        if (event.button !== 0) return;
        if ((transcript.renderer.getSelection()?.getSelectedText() ?? "") !== "") return;
        event.preventDefault();
        event.stopPropagation();
        this.setExpanded(!this.expanded);
      },
    });
    // Sits at the cards' text column, under their icon-wide gutter.
    this.omitted = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("tool-group-omitted"),
      content: "",
      visible: false,
      fg: transcript.theme.dim,
      marginLeft: SPACING.inset + 2,
      wrapMode: "none",
      truncate: true,
    });
    this.body = new BoxRenderable(transcript.renderer, {
      id: transcript.nextId("tool-group-body"),
      flexDirection: "column",
      width: "100%",
    });
    this.container.add(this.heading);
    this.container.add(this.omitted);
    this.container.add(this.body);
    bindSemantics(this.container, () => ({
      role: "group",
      label: "Tool calls",
      expanded: this.cards.length < 2 || this.expanded,
    }));
    const unregister = transcript.toolOutput.register(this);
    this.container.once(RenderableEvents.DESTROYED, unregister);
  }

  add(toolName: string): ToolCard {
    const card = new ToolCard(this.transcript, toolName, this.body, undefined, () =>
      this.repaint(),
    );
    card.container.marginTop = 0;
    this.cards.push(card);
    this.repaint();
    return card;
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.repaint();
  }

  private repaint(): void {
    const grouped = this.cards.length > 1;
    const complete = this.cards.every((card) => card.completed);
    const failed = this.cards.some((card) => card.failed);
    const icon = failed ? GLYPHS.cross : complete ? GLYPHS.check : GLYPHS.bullet;
    const color = failed
      ? this.transcript.theme.error
      : complete
        ? this.transcript.theme.ok
        : this.transcript.theme.running;
    const names = this.cards.map((card) => card.toolName);
    this.heading.content = new StyledText([
      fg(color)(icon),
      fg(this.transcript.theme.foreground)(` ${toolCallVerbs(names)}`),
      fg(this.transcript.theme.dim)(
        `  ${toolCallCounts(names)} · ${keycap("chat.tools.toggle")} ${this.expanded ? "collapse" : "expand"}`,
      ),
    ]);
    this.heading.visible = grouped;
    // Collapsed, the newest calls stay on screen as one-line rows and the
    // rest leave a count; a lone call renders exactly as it would ungrouped.
    const collapsed = grouped && !this.expanded;
    const hidden = collapsed ? Math.max(0, this.cards.length - GROUP_TAIL_CALLS) : 0;
    for (const [index, card] of this.cards.entries()) {
      card.container.visible = index >= hidden;
      card.setCompact(collapsed);
    }
    this.omitted.content = earlierCallsLabel(hidden);
    this.omitted.visible = hidden > 0;
    this.transcript.renderer.requestRender();
  }
}

/** How a turn is drawn before its own events say otherwise. */
interface TurnBlockOptions {
  /** Core-owned identity of the semantic turn. */
  readonly id?: string;
  readonly outcome?: TurnOutcome;
  /**
   * The turn's span as the record has it. A turn drawn from stored entries
   * carries its whole span; a turn opened by a live request carries zero and
   * counts on the status row's clock.
   */
  readonly durationMs?: number;
}

/** One visual owner for a user request and every assistant step it drives. */
export class ConversationTurnBlock {
  private readonly transcript: Transcript;
  private readonly root: TurnSection;
  private readonly users = new Set<string>();
  private readonly reasoning = new Map<string, ReasoningBlock>();
  private readonly assistants = new Map<string, AssistantPartBlock>();
  private readonly tools = new Map<string, ToolCard>();
  /** Texts already noted, so the record's copy and the client's draw once. */
  private readonly notes = new Set<string>();
  private readonly durationMs: number;
  /** Core-owned turn identity: the id of the entry that opened the turn. */
  private id: string | undefined;
  private activity: ActivityBlock | undefined;
  private group: ToolCallGroup | undefined;
  private outcome: TurnOutcome = "completed";
  /** Notes and compactions, which the three block maps do not hold. */
  private appended = false;
  /**
   * A turn ends once, by settling or by leaving the screen. `activity` cannot
   * carry this: it is also undefined on a turn that has drawn nothing yet, and
   * a closed turn's root is destroyed, so anything built under it would attach
   * to a dead renderable.
   */
  private closed = false;

  constructor(transcript: Transcript, options: TurnBlockOptions = {}) {
    this.transcript = transcript;
    this.id = options.id;
    this.outcome = options.outcome ?? "completed";
    this.durationMs = options.durationMs ?? 0;
    this.root = new TurnSection(transcript, options.id);
  }

  /**
   * Adopt the record's identity for a turn the live stream opened without one,
   * which happens when a resumed run draws before its entries commit. True
   * when this block is the turn `id` names.
   */
  claim(id: string): boolean {
    this.id ??= id;
    return this.id === id;
  }

  /** How the turn's own events left it, before a caller overrides the settle. */
  get result(): TurnOutcome {
    return this.outcome;
  }

  /** The turn has settled or left the screen; nothing may reopen it. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * The turn shows a request and nothing that answers it: no thought, no
   * reply, no tool call, no note. The spinner does not count, since it is
   * drawn the moment the request lands.
   */
  get unanswered(): boolean {
    return (
      !this.appended &&
      this.reasoning.size === 0 &&
      this.assistants.size === 0 &&
      this.tools.size === 0
    );
  }

  addUser(content: UserMessage["content"], entryId?: string): void {
    if (entryId !== undefined) {
      const id = `user:${entryId}`;
      if (this.users.has(id)) return;
      this.users.add(id);
    }
    this.group = undefined;
    appendUser(this.transcript, content, this.root);
    this.ensureWorking();
  }

  updateAssistant(event: AssistantMessageEvent, entryId?: string): void {
    if (event.type === "start" || event.type === "done" || event.type === "error") return;
    const key = this.partKey(event.contentIndex, entryId);
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
        if (this.tools.has(event.toolCall.id)) break;
        this.tools.set(event.toolCall.id, this.createToolCard(event.toolCall.name));
        break;
      }
      case "toolcall_start":
      case "toolcall_delta":
        break;
    }
  }

  /** Append a streamed text delta at its part identity, as `watch` overlays carry it. */
  appendAssistantDelta(contentIndex: number, delta: string, entryId?: string): void {
    this.assistantBlock(this.partKey(contentIndex, entryId)).append(delta);
  }

  /** Append a streamed reasoning delta at its part identity. */
  appendReasoningDelta(contentIndex: number, delta: string, entryId?: string): void {
    this.reasoningBlock(this.partKey(contentIndex, entryId)).append(delta);
  }

  finishAssistant(message: AssistantMessage, entryId?: string): void {
    let hasToolCall = false;
    for (const [contentIndex, part] of message.content.entries()) {
      const key = this.partKey(contentIndex, entryId);
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
          this.tools.set(part.id, this.createToolCard(part.name));
        }
      }
    }
    if (!hasToolCall) this.ensureWorking();
    if (message.stopReason === "aborted") this.outcome = "aborted";
    else if (message.stopReason === "error" || message.errorMessage !== undefined) {
      this.outcome = "failed";
    }
  }

  startTool(callId: string, toolName: string): void {
    if (!this.tools.has(callId)) {
      this.tools.set(callId, this.createToolCard(toolName));
    }
  }

  updateTool(callId: string, text: string, title?: string): void {
    this.tools.get(callId)?.update(text, title);
  }

  finishTool(
    callId: string,
    toolName: string,
    text: string,
    options: { isError?: boolean; details?: JsonValue; title?: string } = {},
  ): void {
    let card = this.tools.get(callId);
    if (card === undefined) {
      card = this.createToolCard(toolName);
      this.tools.set(callId, card);
    }
    card.complete(text, options);
  }

  /**
   * Draw one folded part. Every part is keyed by its core identity (entry id
   * and content index, or the tool call id), so a part the live stream already
   * drew is a no-op and repeating a sync never duplicates a block. Restore and
   * live commits both land here: one projection, two arrival orders.
   */
  addStoredPart(part: TurnPart): void {
    switch (part.kind) {
      case "user":
        this.addUser(part.content, part.entryId);
        break;
      case "thinking": {
        const key = this.partKey(part.contentIndex, part.entryId);
        if (this.reasoning.has(key)) break;
        this.appended = true;
        this.group = undefined;
        const block = new ReasoningBlock(this.transcript, this.root, this.contentAnchor());
        this.reasoning.set(key, block);
        block.set(part.text);
        block.finish(this.transcript.theme);
        break;
      }
      case "assistant": {
        const key = this.partKey(part.contentIndex, part.entryId);
        if (this.assistants.has(key)) break;
        this.appended = true;
        this.group = undefined;
        const block = new AssistantPartBlock(
          this.transcript,
          this.root,
          part.text,
          false,
          this.contentAnchor(),
        );
        this.assistants.set(key, block);
        block.finish();
        break;
      }
      case "tool": {
        let card = this.tools.get(part.callId);
        if (card === undefined) {
          card = this.createToolCard(part.toolName);
          this.tools.set(part.callId, card);
        }
        if (part.result !== undefined && !card.completed) {
          card.complete(part.result.output, {
            isError: part.result.isError,
            details: part.result.details,
            title: part.result.title,
          });
        }
        break;
      }
      case "note":
        this.addNote(part.text);
        break;
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  /**
   * One line per distinct text within a turn. The run error is the text that
   * arrives twice, once from the record's note part and once from the run
   * outcome, in either order.
   */
  addNote(text: string, color?: string): void {
    if (this.notes.has(text)) return;
    this.notes.add(text);
    this.appended = true;
    this.group = undefined;
    appendNote(this.transcript, text, color, this.root, this.contentAnchor());
  }

  settle(outcome = this.outcome): void {
    if (this.closed) return;
    this.closed = true;
    // A stream event that draws nothing, such as a message start or a done,
    // still opens the block that owns whatever the message turns out to draw.
    // When it draws nothing at all there is no request and no answer under the
    // row, so the turn leaves rather than stamp a status line over nothing.
    if (this.activity === undefined && this.root.getChildrenCount() === 0) {
      this.discard();
      return;
    }
    for (const block of this.reasoning.values()) block.finish(this.transcript.theme);
    for (const block of this.assistants.values()) block.finish();
    this.ensureWorking().settle(outcome);
    this.activity = undefined;
  }

  /**
   * Take the turn off screen instead of settling it. Used when the message it
   * carries goes back to the composer, where the record has to lose the turn
   * too, so a settled line would only be a line the next reload contradicts.
   */
  discard(): void {
    this.closed = true;
    this.transcript.container.remove(this.root);
    this.root.destroyRecursively();
    this.activity = undefined;
  }

  private partKey(contentIndex: number, entryId?: string): string {
    return `${entryId ?? "live"}:${String(contentIndex)}`;
  }

  private createToolCard(toolName: string): ToolCard {
    const mode = this.transcript.toolCalls;
    switch (mode) {
      case "detailed":
        break;
      case "auto":
        if (!DETAILED_TOOLS.has(toolName)) return this.groupedToolCard(toolName);
        break;
      case "compact":
        return this.groupedToolCard(toolName);
      default: {
        const _exhaustive: never = mode;
        return _exhaustive;
      }
    }
    this.group = undefined;
    return new ToolCard(this.transcript, toolName, this.root, this.contentAnchor());
  }

  private groupedToolCard(toolName: string): ToolCard {
    this.group ??= new ToolCallGroup(this.transcript, this.root, this.contentAnchor());
    return this.group.add(toolName);
  }

  private ensureWorking(): ActivityBlock {
    this.activity ??= new ActivityBlock(this.transcript, this.root, this.durationMs);
    return this.activity;
  }

  /**
   * Where the next block goes. An open turn keeps its status row last, so
   * content lands above it. A closed turn has no status row to raise again.
   */
  private contentAnchor(): Renderable | undefined {
    return this.closed ? undefined : this.ensureWorking().anchor;
  }

  private reasoningBlock(key: string): ReasoningBlock {
    const existing = this.reasoning.get(key);
    if (existing !== undefined) return existing;
    this.group = undefined;
    const block = new ReasoningBlock(this.transcript, this.root, this.contentAnchor());
    this.activity?.beginThinking();
    this.reasoning.set(key, block);
    return block;
  }

  private assistantBlock(key: string): AssistantPartBlock {
    const existing = this.assistants.get(key);
    if (existing !== undefined) return existing;
    this.group = undefined;
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

/** Append one non-turn item: a compaction card, a branch summary, or a marker note. */
export function appendMarkerItem(
  transcript: Transcript,
  item: Exclude<Turn, { kind: "turn" }>,
): void {
  switch (item.kind) {
    case "compaction":
      appendCompaction(transcript, item.entry.summary, item.entry.tokensBefore);
      break;
    case "branch_summary":
      appendBranchSummary(transcript, item.entry.summary, item.entry.fromId);
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

/** Render restored turns with the same owner the live path uses. */
export function renderItems(
  transcript: Transcript,
  items: readonly Turn[],
  options: {
    openLastTurn?: boolean;
    /** Reports each turn block by its core-owned id, for later commits to update. */
    register?: (id: string, turn: ConversationTurnBlock) => void;
  } = {},
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
    if (item.kind !== "turn") {
      appendMarkerItem(transcript, item);
      continue;
    }
    const turn = new ConversationTurnBlock(transcript, {
      id: item.id,
      outcome: item.outcome,
      durationMs: item.durationMs,
    });
    for (const part of item.parts) turn.addStoredPart(part);
    options.register?.(item.id, turn);
    if (index === lastTurnIndex) openTurn = turn;
    else turn.settle(item.outcome);
  }
  return openTurn;
}

/**
 * The line an entry draws on its own. A client that claims an entry before it
 * reaches the session draws the same text a reload would have produced.
 */
function entryNote(entry: ProvisionedEntry): string | undefined {
  if (entry.type === "model_change") return `Model → ${entry.modelId}`;
  if (entry.type === "custom") return customEntryNote(entry);
  return undefined;
}

function customEntryNote(entry: ProvisionedEntry<CustomEntry>): string | undefined {
  return presenter.custom(entry)?.text;
}
