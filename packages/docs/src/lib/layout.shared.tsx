import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { JuneWordmark } from "@/components/brand/mark";
import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Wordmark alone. The tagline used to sit beside it and wrapped to two
      // lines in the sidebar, which pushed the search field down the page.
      title: <JuneWordmark size={18} />,
      url: "/",
    },
    links: [{ text: "Brand", url: "/branding", type: "main" }],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
