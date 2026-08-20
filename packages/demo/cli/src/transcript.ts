/**
 * Transcript blocks: the OpenTUI vocabulary for user, assistant, thinking, and
 * tool content. Live events and restored sessions both render through these,
 * so a resumed session looks like the one that was just typed.
 */
import {
  BoxRenderable,
  DiffRenderable,
  fg,
  link,
  MarkdownRenderable,
  StyledText,
  SyntaxStyle,
  TextRenderable,
} from "@opentui/core";
import type { CliRenderer, Renderable } from "@opentui/core";
import {
  describeToolCall,
  diffFromDetails,
  omittedLabel,
  previewLines,
  type TranscriptItem,
} from "./format.ts";
import type { CliTheme } from "./theme.ts";

export const RESULT_PREVIEW_LINES = 8;
export const DIFF_PREVIEW_LINES = 120;

export function createSyntaxStyle(theme: CliTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: theme.assistant },
    keyword: { fg: theme.code },
    string: { fg: theme.string },
    number: { fg: theme.number },
    comment: { fg: theme.thinking, italic: true },
    function: { fg: theme.user },
    type: { fg: theme.type },
    variable: { fg: theme.assistant },
    operator: { fg: theme.operator },
    punctuation: { fg: theme.dim },
    "markup.heading": { fg: theme.user, bold: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: theme.code },
    "markup.link": { fg: theme.user, underline: true },
    "markup.list": { fg: theme.tool },
    "markup.quote": { fg: theme.dim, italic: true },
    conceal: { fg: theme.dim },
  });
}

export interface Transcript {
  renderer: CliRenderer;
  container: Renderable;
  syntaxStyle: SyntaxStyle;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
}

function block(
  transcript: Transcript,
  prefix: string,
  color: string,
  options: { marginTop?: number } = {},
): BoxRenderable {
  const box = new BoxRenderable(transcript.renderer, {
    id: transcript.nextId(prefix),
    flexDirection: "column",
    border: ["left"],
    borderStyle: "heavy",
    borderColor: color,
    paddingLeft: 1,
    marginTop: options.marginTop ?? 1,
    width: "100%",
  });
  transcript.container.add(box);
  return box;
}

function label(transcript: Transcript, text: string, color: string): TextRenderable {
  return new TextRenderable(transcript.renderer, {
    id: transcript.nextId("label"),
    content: text,
    fg: color,
  });
}

export function appendUser(transcript: Transcript, text: string): void {
  const box = block(transcript, "user", transcript.theme.user);
  box.add(label(transcript, "you", transcript.theme.user));
  box.add(
    new TextRenderable(transcript.renderer, {
      id: transcript.nextId("user-text"),
      content: text,
      fg: transcript.theme.foreground,
      wrapMode: "word",
    }),
  );
}

/** A short one-line note: session info, command output, errors. */
export function appendNote(transcript: Transcript, text: string, color?: string): void {
  transcript.container.add(
    new TextRenderable(transcript.renderer, {
      id: transcript.nextId("note"),
      content: text,
      fg: color ?? transcript.theme.dim,
      wrapMode: "word",
    }),
  );
}

export function authUrlText(url: string, color: string): StyledText {
  return new StyledText([link(url)(fg(color)(url))]);
}

/** Keep the visible auth URL complete and attach one link target across wrapped rows. */
export function appendAuthUrl(transcript: Transcript, url: string): void {
  transcript.container.add(
    new TextRenderable(transcript.renderer, {
      id: transcript.nextId("auth-url"),
      content: authUrlText(url, transcript.theme.user),
      wrapMode: "char",
    }),
  );
}

/** Streamed assistant markdown. Call `append` per delta, `finish` once. */
export class AssistantBlock {
  private readonly markdown: MarkdownRenderable;
  private buffer = "";

  constructor(transcript: Transcript, initial = "", streaming = true) {
    const box = block(transcript, "assistant", transcript.theme.assistant);
    box.add(label(transcript, "june", transcript.theme.ok));
    this.buffer = initial;
    this.markdown = new MarkdownRenderable(transcript.renderer, {
      id: transcript.nextId("assistant-md"),
      content: initial,
      syntaxStyle: transcript.syntaxStyle,
      streaming,
    });
    box.add(this.markdown);
  }

  append(delta: string): void {
    this.buffer += delta;
    this.markdown.content = this.buffer;
  }

  finish(): void {
    this.markdown.streaming = false;
  }

  get text(): string {
    return this.buffer;
  }
}

/** Reasoning summary. Dim, collapsed to a preview so it never dominates. */
export class ThinkingBlock {
  private readonly text: TextRenderable;
  private buffer = "";

  constructor(transcript: Transcript, initial = "") {
    const box = block(transcript, "thinking", transcript.theme.thinking);
    box.add(label(transcript, "thinking", transcript.theme.thinking));
    this.text = new TextRenderable(transcript.renderer, {
      id: transcript.nextId("thinking-text"),
      content: "",
      fg: transcript.theme.thinking,
      wrapMode: "word",
    });
    box.add(this.text);
    if (initial !== "") this.append(initial);
  }

  append(delta: string): void {
    this.buffer += delta;
    const preview = previewLines(this.buffer, RESULT_PREVIEW_LINES);
    this.text.content =
      preview.omitted === 0 ? preview.text : `${preview.text}\n${omittedLabel(preview.omitted)}`;
  }
}

/**
 * One card per tool call, reused from start through partial updates and the
 * final result. Edit diffs render with DiffRenderable; everything else shows a
 * capped preview that says how many lines were left out.
 */
export class ToolCard {
  private readonly transcript: Transcript;
  private readonly box: BoxRenderable;
  private readonly heading: TextRenderable;
  private readonly title: string;
  private body: Renderable | undefined;
  private omitted: TextRenderable | undefined;

  constructor(transcript: Transcript, toolName: string, args: unknown) {
    this.transcript = transcript;
    const { title, detail } = describeToolCall(toolName, args);
    this.title = title;
    this.box = block(transcript, "tool", transcript.theme.tool);
    this.heading = label(transcript, `⚒ ${title}`, transcript.theme.tool);
    this.box.add(this.heading);
    if (detail !== undefined) this.showPreview(detail, transcript.theme.dim);
  }

  update(text: string): void {
    this.heading.content = `⚒ ${this.title} …`;
    this.showPreview(text, this.transcript.theme.dim);
  }

  complete(text: string, options: { isError?: boolean; details?: unknown } = {}): void {
    const isError = options.isError ?? false;
    this.heading.content = `${isError ? "✗" : "✓"} ${this.title}`;
    this.heading.fg = isError ? this.transcript.theme.error : this.transcript.theme.tool;
    this.box.borderColor = isError ? this.transcript.theme.error : this.transcript.theme.tool;
    const diff = diffFromDetails(options.details);
    if (diff !== undefined && !isError) {
      this.clearBody();
      const preview = previewLines(diff, DIFF_PREVIEW_LINES);
      this.body = new DiffRenderable(this.transcript.renderer, {
        id: this.transcript.nextId("tool-diff"),
        diff: preview.text,
        view: "unified",
        showLineNumbers: true,
        syntaxStyle: this.transcript.syntaxStyle,
        wrapMode: "none",
      });
      this.box.add(this.body);
      if (preview.omitted > 0) {
        this.omitted = label(
          this.transcript,
          omittedLabel(preview.omitted),
          this.transcript.theme.dim,
        );
        this.box.add(this.omitted);
      }
      return;
    }
    this.showPreview(text, isError ? this.transcript.theme.error : this.transcript.theme.dim);
  }

  private showPreview(text: string, color: string): void {
    this.clearBody();
    const preview = previewLines(text, RESULT_PREVIEW_LINES);
    if (preview.text === "") return;
    this.body = new TextRenderable(this.transcript.renderer, {
      id: this.transcript.nextId("tool-body"),
      content: preview.text,
      fg: color,
      wrapMode: "none",
    });
    this.box.add(this.body);
    if (preview.omitted > 0) {
      this.omitted = label(
        this.transcript,
        omittedLabel(preview.omitted),
        this.transcript.theme.dim,
      );
      this.box.add(this.omitted);
    }
  }

  private clearBody(): void {
    if (this.body !== undefined) {
      this.box.remove(this.body);
      this.body.destroy();
      this.body = undefined;
    }
    if (this.omitted !== undefined) {
      this.box.remove(this.omitted);
      this.omitted.destroy();
      this.omitted = undefined;
    }
  }
}

/** Render restored items with the same blocks the live path uses. */
export function renderItems(transcript: Transcript, items: TranscriptItem[]): void {
  for (const item of items) {
    switch (item.kind) {
      case "user":
        appendUser(transcript, item.text);
        break;
      case "assistant":
        new AssistantBlock(transcript, item.text, false);
        break;
      case "thinking":
        new ThinkingBlock(transcript, item.text);
        break;
      case "tool": {
        const card = new ToolCard(transcript, item.toolName, item.args);
        if (item.output !== undefined) {
          card.complete(item.output, { isError: item.output.startsWith("Error:") });
        }
        break;
      }
      case "note":
        appendNote(transcript, item.text);
        break;
    }
  }
}
