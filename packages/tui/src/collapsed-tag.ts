import { fg, ImageRenderable, link, StyledText, TextRenderable } from "@opentui/core";
import type { BoxRenderable, CliRenderer } from "@opentui/core";
import type { ImageContent } from "@uji-ai/schema";
import type { CliTheme } from "./theme.ts";

/** Images may fill their container but never consume the whole viewport. */
const IMAGE_PREVIEW_MAX_VIEWPORT_RATIO = 0.5;

export function imagePreviewMaxHeight(rendererHeight: number): number {
  return Math.max(1, Math.floor(rendererHeight * IMAGE_PREVIEW_MAX_VIEWPORT_RATIO));
}

interface CollapsedTagContext {
  renderer: CliRenderer;
  theme: CliTheme;
  nextId: (prefix?: string) => string;
}

interface CollapsedTagOptions {
  id: string;
  label: () => string;
  url?: string;
  marginTop?: number;
  onToggle: () => void;
}

/**
 * Every folded item opens the same way in both editable and sent messages.
 * Keeping the mouse and selection rules here prevents those two copies of the
 * same affordance from drifting apart.
 */
export function collapsedTag(
  context: CollapsedTagContext,
  parent: BoxRenderable,
  options: CollapsedTagOptions,
): TextRenderable {
  const { renderer, theme } = context;
  let hovered = false;
  const tag = new TextRenderable(renderer, {
    id: context.nextId(options.id),
    content: "",
    fg: theme.pasteForeground,
    bg: theme.pasteBackground,
    wrapMode: "none",
    ...(options.marginTop === undefined ? {} : { marginTop: options.marginTop }),
  });
  const paint = (): void => {
    const text = options.label();
    // The link keeps cmd-click opening the real file even though a plain
    // click is bound to expanding it in place.
    tag.content =
      options.url === undefined
        ? new StyledText([fg(theme.pasteForeground)(text)])
        : new StyledText([link(options.url)(fg(theme.pasteForeground)(text))]);
    tag.bg = hovered ? theme.hover : theme.pasteBackground;
  };
  tag.onMouseOver = () => {
    hovered = true;
    paint();
  };
  tag.onMouseOut = () => {
    hovered = false;
    paint();
  };
  tag.onMouseUp = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // A drag that happens to end on the tag was someone selecting text, so it
    // clears the selection instead of toggling what it swept over.
    const selected = renderer.getSelection()?.getSelectedText() ?? "";
    renderer.clearSelection();
    if (selected !== "") return;
    options.onToggle();
    paint();
  };
  paint();
  parent.add(tag);
  return tag;
}

/** Build the shared image preview so composer and transcript sizing stays exact. */
export function collapsedImagePreview(
  context: Pick<CollapsedTagContext, "nextId" | "renderer">,
  image: ImageContent,
): ImageRenderable {
  let sourceWidth: number | undefined;
  let sourceHeight: number | undefined;
  const preview = new ImageRenderable(context.renderer, {
    id: context.nextId("image-preview"),
    width: "100%",
    visible: false,
    fit: "fit",
  });
  const sizePreview = (): void => {
    if (sourceWidth === undefined || sourceHeight === undefined) return;
    const availableWidth = Math.max(1, preview.width > 0 ? preview.width : context.renderer.width);
    const fitted = preview.getFittedSize(
      availableWidth,
      imagePreviewMaxHeight(context.renderer.height),
      undefined,
      sourceWidth,
      sourceHeight,
    );
    if (preview.height !== fitted.height) preview.height = fitted.height;
  };
  preview.onSizeChange = sizePreview;
  preview.onLoad = (loaded) => {
    sourceWidth = loaded.width;
    sourceHeight = loaded.height;
    sizePreview();
  };
  preview.source = `data:${image.mimeType};base64,${image.data}`;
  return preview;
}
