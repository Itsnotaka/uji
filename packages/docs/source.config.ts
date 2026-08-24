import { defineConfig } from "fumadocs-mdx/config";
import {
  rehypeCodeDefaultOptions,
  remarkMdxFiles,
  remarkMdxMermaid,
} from "fumadocs-core/mdx-plugins";

/*
 * Collections live in `src/lib/source.ts` via the `fumadocs-mdx/macro` API. This
 * file exists only for global MDX options, which the macro collections inherit.
 *
 * Setting `mdxOptions` on a collection would drop the default plugin set;
 * setting it here merges with the `fumadocs` preset instead, so `remarkGfm`,
 * `rehypeCode`, and the rest stay in place.
 */
export default defineConfig({
  mdxOptions: {
    // ```mermaid → <Mermaid />, ```files → <Files />. Both resolve from
    // src/components/mdx.tsx.
    remarkPlugins: (plugins) => [remarkMdxMermaid, remarkMdxFiles, ...plugins],
    // Dual-theme Shiki tokens (`--shiki-light` / `--shiki-dark`) plus the
    // default notation transformers and language icons on titled blocks.
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      defaultColor: false,
    },
  },
});
