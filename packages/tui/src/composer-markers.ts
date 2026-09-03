import {
  CodeRenderable,
  pathToFiletype,
  SyntaxStyle,
  TextRenderable,
  type BoxRenderable,
  type CliRenderer,
  type Renderable,
  type TextareaRenderable,
} from "@opentui/core";
import type { ComposerPart } from "./composer.ts";
import { collapsedImagePreview } from "./collapsed-tag.ts";
import type { CliTheme } from "./theme.ts";
import { cellOffset, displayWidth } from "./width.ts";

const MAX_TEXT_PREVIEW_ROWS = 12;

/** Name of the pill style inside the composer textarea's syntax style. */
export const COMPOSER_MARKER_STYLE = "composer.marker";

/** The style the textarea needs so inline markers can render as pills. */
export function composerMarkerSyntaxStyle(theme: CliTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    [COMPOSER_MARKER_STYLE]: { fg: theme.pasteForeground, bg: theme.pasteBackground },
  });
}

interface ComposerMarkersOptions {
  renderer: CliRenderer;
  input: TextareaRenderable;
  preview: BoxRenderable;
  /** Highlights file previews; the pill style lives on the input's buffer. */
  previewSyntaxStyle: SyntaxStyle;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
  fileBody: (part: Extract<ComposerPart, { kind: "file" }>) => Promise<string | undefined>;
  openPath: (path: string) => void;
}

/**
 * Presentation state for composer-owned parts. Markers stay literal text in
 * the buffer — submission and retention read that text — while a virtual
 * extmark over each one renders it as an atomic pill: styled inline, skipped
 * by the cursor, deleted whole. Clicking a pill toggles its preview; the
 * preview survives ordinary typing because the part objects stay stable, and
 * an in-flight file read is invalidated when another pill wins the slot.
 */
export class ComposerMarkers {
  private readonly options: ComposerMarkersOptions;
  private pillStyleId: number | undefined;
  private parts: readonly ComposerPart[] = [];
  private activeMarker: string | undefined;
  private generation = 0;
  private painted = false;

  constructor(options: ComposerMarkersOptions) {
    this.options = options;
    this.pillStyleId =
      options.input.editBuffer.getSyntaxStyle()?.getStyleId(COMPOSER_MARKER_STYLE) ?? undefined;
  }

  /** Refresh cached syntax after the shared palette changes. */
  retheme(previewSyntaxStyle: SyntaxStyle): void {
    this.options.previewSyntaxStyle = previewSyntaxStyle;
    this.pillStyleId =
      this.options.input.editBuffer.getSyntaxStyle()?.getStyleId(COMPOSER_MARKER_STYLE) ??
      undefined;
    this.closePreview();
    this.paintMarkers();
  }

  refresh(parts: readonly ComposerPart[]): void {
    const unchanged =
      parts.length === this.parts.length &&
      parts.every((part, index) => part === this.parts[index]);
    if (!unchanged) {
      const previousActive = this.parts.find((part) => part.marker === this.activeMarker);
      const nextActive = parts.find((part) => part.marker === this.activeMarker);
      if (previousActive !== nextActive) this.closePreview();
      this.parts = parts;
    }
    // Repaint even when the parts are unchanged: programmatic setText wipes
    // every extmark while the parts it restored are the same objects.
    this.paintMarkers();
  }

  /** Toggle the preview for the pill under this visual offset, if any. */
  toggleAtOffset(offset: number): boolean {
    const input = this.options.input;
    const mark = input.extmarks.getAtOffset(offset)[0];
    if (mark === undefined) return false;
    // The controller types extmark data as `any`; ours is always the marker.
    const marker: unknown = mark.data;
    const part = this.parts.find((candidate) => candidate.marker === marker);
    if (part === undefined) return false;
    // The click parked the cursor inside the pill; park it after instead so
    // the next keystroke never lands mid-marker.
    input.cursorOffset = mark.end;
    this.toggle(part);
    return true;
  }

  /**
   * Rebuild the pills from the buffer text. Recreating from scratch is cheap
   * at composer scale and self-heals every path — typing, undo, programmatic
   * setText — that could let extmarks drift from the markers they cover.
   */
  private paintMarkers(): void {
    if (this.parts.length === 0 && !this.painted) return;
    this.painted = this.parts.length > 0;
    const input = this.options.input;
    const text = input.plainText;
    input.extmarks.clear();
    for (const part of this.parts) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(part.marker, from);
        if (index === -1) break;
        const start = cellOffset(text, index);
        input.extmarks.create({
          start,
          end: start + displayWidth(part.marker),
          virtual: true,
          ...(this.pillStyleId === undefined ? {} : { styleId: this.pillStyleId }),
          data: part.marker,
        });
        from = index + part.marker.length;
      }
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
      syntaxStyle: this.options.previewSyntaxStyle,
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
    for (const child of this.options.preview.getChildren()) {
      this.options.preview.remove(child);
      child.destroyRecursively();
    }
    this.options.preview.visible = false;
  }
}
