/**
 * Pierre is a leaf renderer here: Uji supplies the patch, mode, typography,
 * and surrounding geometry. The package's shadow root gets one inherited
 * token bridge because StyleX cannot address that boundary.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/app/src/lib/diff-rendering.ts
 */
import * as stylex from "@stylexjs/stylex";
import type { FileDiffOptions, ThemesType } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { memo } from "react";
import type { ReactElement } from "react";
import { useAppearanceSettings } from "../theme/use-appearance.ts";
import { pierrePatchStyles } from "./styles.stylex.ts";

const THEMES = { light: "github-light", dark: "github-dark" } satisfies ThemesType;

// Shadow-DOM contract only. Layout outside the renderer remains in StyleX.
const PIERRE_SHADOW_CSS = `
:host {
  min-width: 0;
  max-width: 100%;
  --diffs-bg: var(--cursor-bg-editor);
  --diffs-bg-buffer: var(--cursor-bg-editor);
  --diffs-bg-context: var(--cursor-bg-editor);
  --diffs-bg-context-gutter: var(--cursor-bg-editor);
  --diffs-bg-separator: var(--cursor-bg-quinary);
  --diffs-fg: var(--cursor-text-primary);
  --diffs-fg-number: var(--cursor-text-quaternary);
  --diffs-addition-base: var(--cursor-added);
  --diffs-deletion-base: var(--cursor-removed);
  --diffs-bg-addition-emphasis: var(--cursor-diff-added-text-background);
  --diffs-bg-deletion-emphasis: var(--cursor-diff-removed-text-background);
  --diffs-gap-style: none;
  --diffs-min-number-column-width: 34px;
  --diffs-font-family: var(--cursor-font-family-mono);
  --diffs-header-font-family: var(--cursor-font-family-sans);
  --diffs-font-size: var(--cursor-font-size-code);
  --diffs-line-height: var(--uji-diff-line-height);
}

[data-line-type="change-addition"] {
  --diffs-line-bg: var(--cursor-diff-added-line-background);
}

[data-line-type="change-deletion"] {
  --diffs-line-bg: var(--cursor-diff-removed-line-background);
}

* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

*:hover {
  scrollbar-color: var(--cursor-scrollbar-thumb) transparent;
}

::-webkit-scrollbar {
  width: var(--uji-scrollbar-lane);
  height: var(--uji-scrollbar-lane);
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  min-width: 28px;
  min-height: 28px;
  border: 4px solid transparent;
  border-radius: 999px;
  background: transparent;
  background-clip: padding-box;
}

*:hover::-webkit-scrollbar-thumb {
  background-color: var(--cursor-scrollbar-thumb);
}

*:hover::-webkit-scrollbar-thumb:hover {
  background-color: var(--cursor-scrollbar-thumb-hover);
}
`;

const BASE_OPTIONS = {
  theme: THEMES,
  diffStyle: "unified",
  diffIndicators: "classic",
  disableBackground: true,
  disableFileHeader: true,
  hunkSeparators: "line-info-basic",
  lineDiffType: "word",
  overflow: "scroll",
  preferredHighlighter: "shiki-js",
  unsafeCSS: PIERRE_SHADOW_CSS,
} satisfies FileDiffOptions<undefined>;

export const PierrePatch = memo(function PierrePatch({
  patch,
}: {
  readonly patch: string;
}): ReactElement {
  const appearance = useAppearanceSettings();
  const options = {
    ...BASE_OPTIONS,
    themeType: appearance.theme,
  } satisfies FileDiffOptions<undefined>;
  const host = stylex.props(pierrePatchStyles.host);

  return <PatchDiff patch={patch} options={options} className={host.className} />;
});
