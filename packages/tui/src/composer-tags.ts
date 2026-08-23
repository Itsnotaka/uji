import {
  CodeRenderable,
  pathToFiletype,
  TextRenderable,
  type BoxRenderable,
  type CliRenderer,
  type Renderable,
  type SyntaxStyle,
} from "@opentui/core";
import { pathToFileURL } from "node:url";
import type { ComposerPart } from "./composer.ts";
import { collapsedImagePreview, collapsedTag } from "./collapsed-tag.ts";
import type { CliTheme } from "./theme.ts";

const MAX_TEXT_PREVIEW_ROWS = 12;

export function composerPartTagLabel(part: ComposerPart): string {
  return ` ${part.marker.slice(1, -1)} `;
}

interface ComposerTagsOptions {
  renderer: CliRenderer;
  tags: BoxRenderable;
  preview: BoxRenderable;
  syntaxStyle: SyntaxStyle;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
  fileBody: (part: Extract<ComposerPart, { kind: "file" }>) => Promise<string | undefined>;
  openPath: (path: string) => void;
}

/**
 * Presentation state for composer-owned parts. It keeps one preview alive
 * while ordinary typing retains the same part objects, and invalidates an
 * in-flight file read when another tag wins the preview slot.
 */
export class ComposerTags {
  private readonly options: ComposerTagsOptions;
  private parts: readonly ComposerPart[] = [];
  private activeMarker: string | undefined;
  private generation = 0;

  constructor(options: ComposerTagsOptions) {
    this.options = options;
  }

  refresh(parts: readonly ComposerPart[]): void {
    if (
      parts.length === this.parts.length &&
      parts.every((part, index) => part === this.parts[index])
    ) {
      return;
    }

    const previousActive = this.parts.find((part) => part.marker === this.activeMarker);
    const nextActive = parts.find((part) => part.marker === this.activeMarker);
    if (previousActive !== nextActive) this.closePreview();

    this.parts = parts;
    this.clearChildren(this.options.tags);
    this.options.tags.visible = parts.length > 0;
    for (const part of parts) {
      collapsedTag(this.options, this.options.tags, {
        id: `composer-${part.kind}-tag`,
        ...(part.kind === "file" ? { url: pathToFileURL(part.path).href } : {}),
        label: () => composerPartTagLabel(part),
        onToggle: () => this.toggle(part),
      });
    }
  }

  private toggle(part: ComposerPart): void {
    if (this.activeMarker === part.marker) {
      this.closePreview();
      return;
    }
    this.closePreview();
    this.activeMarker = part.marker;
    const generation = this.generation;
    switch (part.kind) {
      case "paste":
        this.showTextPreview(part.text);
        return;
      case "image":
        this.showImagePreview(part);
        return;
      case "file":
        void this.showFilePreview(part, generation);
        return;
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  }

  private showTextPreview(text: string): void {
    const body = new TextRenderable(this.options.renderer, {
      id: this.options.nextId("composer-paste-preview"),
      content: text,
      maxHeight: MAX_TEXT_PREVIEW_ROWS,
      overflow: "hidden",
      wrapMode: "word",
      selectionBg: this.options.theme.selectionBackground,
      selectionFg: this.options.theme.selectionForeground,
    });
    this.showPreview(body);
  }

  private async showFilePreview(
    part: Extract<ComposerPart, { kind: "file" }>,
    generation: number,
  ): Promise<void> {
    const text = await this.options.fileBody(part);
    if (generation !== this.generation || this.activeMarker !== part.marker) return;
    if (text === undefined) {
      this.closePreview();
      this.options.openPath(part.path);
      return;
    }
    const body = new CodeRenderable(this.options.renderer, {
      id: this.options.nextId("composer-file-preview"),
      content: text,
      filetype: pathToFiletype(part.path) ?? undefined,
      syntaxStyle: this.options.syntaxStyle,
      maxHeight: MAX_TEXT_PREVIEW_ROWS,
      overflow: "hidden",
      selectionBg: this.options.theme.selectionBackground,
      selectionFg: this.options.theme.selectionForeground,
    });
    this.showPreview(body);
  }

  private showImagePreview(part: Extract<ComposerPart, { kind: "image" }>): void {
    const preview = collapsedImagePreview(this.options, part.image);
    preview.visible = true;
    preview.onSizeChange?.();
    this.showPreview(preview);
  }

  private showPreview(preview: Renderable): void {
    this.options.preview.add(preview);
    this.options.preview.visible = true;
  }

  private closePreview(): void {
    this.generation += 1;
    this.activeMarker = undefined;
    this.clearChildren(this.options.preview);
    this.options.preview.visible = false;
  }

  private clearChildren(parent: BoxRenderable): void {
    for (const child of parent.getChildren()) {
      parent.remove(child);
      child.destroyRecursively();
    }
  }
}
