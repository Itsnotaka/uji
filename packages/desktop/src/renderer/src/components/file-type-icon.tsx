/**
 * File identity is Pierre's concern; size and color remain Uji schema choices.
 * One shared sprite keeps rows cheap, while exact basenames and compound
 * extensions stay inside Pierre's resolver instead of becoming desktop lore.
 *
 * Based on https://github.com/interfaces-lab/honk/blob/main/packages/ui/src/file-type-icon.tsx
 */
import * as stylex from "@stylexjs/stylex";
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";
import type { ReactElement } from "react";
import { t } from "../theme/vars.stylex.ts";

type FileIconTone =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "purple"
  | "magenta";

const GLYPH_SIZE = "1em";
const resolver = createFileTreeIconResolver("complete");
const spriteMarkup = { __html: getBuiltInSpriteSheet("complete") };

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    flexShrink: 0,
    fontSize: 14,
    lineHeight: 1,
  },
  sprite: {
    position: "absolute",
    width: 0,
    height: 0,
    overflow: "hidden",
    pointerEvents: "none",
  },
  gray: { color: t.iconSecondary },
  red: { color: t.red },
  orange: { color: t.orange },
  yellow: { color: t.yellow },
  green: { color: t.green },
  cyan: { color: t.cyan },
  blue: { color: t.accent },
  purple: { color: t.purple },
  magenta: { color: t.magenta },
});

const TONE_STYLE = {
  gray: styles.gray,
  red: styles.red,
  orange: styles.orange,
  yellow: styles.yellow,
  green: styles.green,
  cyan: styles.cyan,
  blue: styles.blue,
  purple: styles.purple,
  magenta: styles.magenta,
} satisfies Record<FileIconTone, stylex.StyleXStyles>;

const TOKEN_TONE: Readonly<Record<string, FileIconTone>> = {
  astro: "purple",
  babel: "yellow",
  bash: "green",
  biome: "blue",
  bootstrap: "purple",
  browserslist: "yellow",
  bun: "magenta",
  c: "blue",
  claude: "orange",
  cpp: "blue",
  css: "purple",
  database: "purple",
  docker: "blue",
  eslint: "purple",
  git: "orange",
  go: "cyan",
  graphql: "magenta",
  html: "orange",
  image: "magenta",
  javascript: "yellow",
  json: "orange",
  markdown: "green",
  mcp: "cyan",
  npm: "red",
  oxc: "cyan",
  postcss: "red",
  prettier: "cyan",
  python: "blue",
  react: "cyan",
  ruby: "red",
  rust: "orange",
  sass: "magenta",
  svelte: "red",
  svg: "orange",
  svgo: "green",
  swift: "orange",
  table: "cyan",
  tailwind: "cyan",
  terraform: "purple",
  typescript: "blue",
  vite: "purple",
  vscode: "blue",
  vue: "green",
  wasm: "purple",
  webpack: "blue",
  yml: "red",
  zig: "orange",
  zip: "orange",
};

export function FileTypeIcon({ path }: { readonly path: string }): ReactElement {
  const icon = resolver.resolveIcon("file-tree-icon-file", path.replaceAll("\\", "/"));
  const tone = TOKEN_TONE[icon.token ?? ""] ?? "gray";
  const width = icon.width ?? 16;
  const height = icon.height ?? 16;

  return (
    <span aria-hidden="true" {...stylex.props(styles.root, TONE_STYLE[tone])}>
      <svg
        data-icon-name={icon.name}
        viewBox={icon.viewBox ?? `0 0 ${String(width)} ${String(height)}`}
        width={GLYPH_SIZE}
        height={GLYPH_SIZE}
        focusable="false"
      >
        <use href={`#${icon.name}`} />
      </svg>
    </span>
  );
}

export function FileTypeIconSprite(): ReactElement {
  return (
    <span
      aria-hidden="true"
      {...stylex.props(styles.sprite)}
      dangerouslySetInnerHTML={spriteMarkup}
    />
  );
}
