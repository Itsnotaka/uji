import { defineConfig } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";

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
    // Rewrites ```mermaid fences into <Mermaid chart="..." />, which
    // src/components/mdx.tsx resolves.
    remarkPlugins: (plugins) => [remarkMdxMermaid, ...plugins],
  },
});
