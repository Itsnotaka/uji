import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";

/*
 * Sidebar corrections, merged onto the <aside> via tailwind-merge:
 *
 * - text-[0.8125rem] replaces the stock text-sm so links, folder toggles,
 *   and the plain-<p> section labels all inherit one size. The search field
 *   sets its own text-sm and needs the explicit override.
 *
 * Canonicalized with `tailwindcss canonicalize` (v4 syntax: `**:` is the
 * descendant combinator variant, data-search-full the bare data variant).
 * - The collapse trigger ships as a 30px button with an 18px glyph, which
 *   crowds the wordmark; 24px with a 16px glyph.
 */
const sidebarClassName = [
  "text-[0.8125rem]",
  "**:data-search-full:text-[0.8125rem]",
  "[&_button[data-collapsed]]:p-1",
  "[&_button[data-collapsed]_svg]:size-4",
].join(" ");

export default function Layout({ children }: LayoutProps<"/docs">) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      sidebar={{ className: sidebarClassName }}
    >
      {children}
    </DocsLayout>
  );
}
