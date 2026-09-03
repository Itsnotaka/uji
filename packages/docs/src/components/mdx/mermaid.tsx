import { renderMermaidSVG } from "beautiful-mermaid";

/*
 * Based on https://github.com/fuma-nama/fumadocs/blob/main/apps/docs/components/mdx/mermaid.tsx
 *
 * `remarkMdxMermaid` rewrites ```mermaid fences into <Mermaid chart="..." />.
 * Beautiful Mermaid embeds its own CSS. Fumadocs color variables keep it in
 * sync with the active light or dark theme without a client-side re-render.
 */

export function Mermaid({ chart }: { chart: string }) {
  const svg = renderMermaidSVG(chart.replaceAll("\\n", "\n"), {
    bg: "var(--color-fd-background)",
    fg: "var(--color-fd-foreground)",
    transparent: true,
  });

  return (
    <div className="fd-mermaid my-4 overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
