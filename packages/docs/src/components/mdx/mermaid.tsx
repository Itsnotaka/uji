"use client";

import { use, useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";

/*
 * Based on https://github.com/fuma-nama/fumadocs/blob/main/apps/docs/components/mdx/mermaid.tsx
 *
 * Two changes from the reference version: the diagram is themed from June's own
 * tokens rather than Mermaid's default palette, and it renders client-side
 * after mount so the server never has to agree with the resolved theme.
 *
 * `remarkMdxMermaid` (source.config.ts) rewrites ```mermaid code blocks into
 * this component, so authors write a fenced block and nothing else.
 */

export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Reserve the row so the surrounding prose does not jump when it arrives.
    return <div aria-hidden className="my-6 h-32" />;
  }

  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function token(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cachePromise("mermaid", () => import("mermaid")));

  const paper = token("--color-june-paper", "#fcfcfc");
  const surface = token("--color-june-surface", "#f7f7f7");
  const rule = token("--color-june-rule", "#14141426");
  const ink = token("--color-june-ink", "#141414");
  const muted = token("--color-june-muted", "#14141499");
  const signal = token("--color-june-signal", "#0c64c1");

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    theme: "base",
    flowchart: {
      curve: "basis",
      nodeSpacing: 44,
      rankSpacing: 56,
      padding: 14,
      useMaxWidth: true,
    },
    themeVariables: {
      background: paper,
      primaryColor: surface,
      primaryTextColor: ink,
      primaryBorderColor: rule,
      secondaryColor: paper,
      tertiaryColor: paper,
      lineColor: muted,
      textColor: ink,
      mainBkg: surface,
      nodeBorder: rule,
      clusterBkg: paper,
      clusterBorder: rule,
      edgeLabelBackground: paper,
      titleColor: ink,
      noteBkgColor: surface,
      noteTextColor: ink,
      noteBorderColor: rule,
      actorBkg: surface,
      actorBorder: rule,
      actorTextColor: ink,
      signalColor: muted,
      signalTextColor: ink,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: signal,
      labelTextColor: ink,
      loopTextColor: ink,
      activationBorderColor: signal,
      activationBkgColor: paper,
      sequenceNumberColor: paper,
    },
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () =>
      mermaid.render(id.replaceAll(":", "-"), chart.replaceAll("\\n", "\n")),
    ),
  );

  return (
    <div
      className="june-mermaid my-6 overflow-x-auto rounded-xl border border-fd-border bg-fd-card px-4 py-6"
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
