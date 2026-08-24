import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { UjiWordmark } from "@/components/brand/mark";
import { docsRoute, gitConfig } from "./shared";

/** Shared by DocsLayout and HomeLayout. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Wordmark alone. The tagline used to sit beside it and wrapped to two
      // lines in the sidebar, which pushed the search field down the page.
      title: <UjiWordmark size={18} />,
      url: "/",
    },
    links: [
      { text: "Docs", url: docsRoute, type: "main" },
      { text: "Brand", url: "/branding", type: "main" },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
