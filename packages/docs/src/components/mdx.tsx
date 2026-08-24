import defaultMdxComponents from "fumadocs-ui/mdx";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import type { MDXComponents } from "mdx/types";
import { DocCard } from "@/components/mdx/doc-card";
import { Mermaid } from "@/components/mdx/mermaid";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    File,
    Files,
    Folder,
    Mermaid,
    DocCard,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
