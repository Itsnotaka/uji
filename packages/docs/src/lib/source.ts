import { loader } from "fumadocs-core/source";
import type { LoaderPlugin } from "fumadocs-core/source";
import * as centralIcons from "central-icons";
import { createElement } from "react";
import { docsContentRoute, docsImageRoute, docsRoute } from "./shared";
import { defineDocs } from "fumadocs-mdx/macro";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

/*
 * Resolves an `icon:` name in frontmatter or meta.json against Central Icons,
 * the same set the Electron client uses. Fumadocs ships `lucideIconsPlugin`,
 * but its own chrome is the only thing that should be on Lucide here.
 *
 * Same shape as fumadocs-core's internal `iconPlugin`, which is not exported.
 * Names are the package's own, e.g. `IconPackage`, `IconConsole`.
 */
function centralIconsPlugin(): LoaderPlugin {
  const icons = centralIcons as unknown as Record<string, React.ComponentType>;

  function replaceIcon<T extends { icon?: unknown }>(node: T): T {
    if (typeof node.icon !== "string") return node;

    const Icon = icons[node.icon];
    if (!Icon) {
      console.warn(`[central-icons-plugin] Unknown icon: ${node.icon}`);
      node.icon = undefined;
      return node;
    }

    node.icon = createElement(Icon);
    return node;
  }

  return {
    name: "june:central-icons",
    transformPageTree: {
      file: replaceIcon,
      folder: replaceIcon,
      separator: replaceIcon,
    },
  };
}

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [centralIconsPlugin()],
});

export function getPageImageUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.png"];

  return {
    segments,
    url: "/" + [page.locale, ...docsImageRoute.split("/"), ...segments].filter(Boolean).join("/"),
  };
}

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: "/" + [page.locale, ...docsContentRoute.split("/"), ...segments].filter(Boolean).join("/"),
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}
