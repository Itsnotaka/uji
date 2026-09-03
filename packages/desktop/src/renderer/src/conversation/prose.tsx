/**
 * Streaming Markdown is parsed and hardened by Streamdown. Uji supplies the
 * semantic components so links still cross the desktop host boundary and
 * fenced code retains the visibility + idle + dynamic-import rendering path.
 */
import * as stylex from "@stylexjs/stylex";
import { Children, isValidElement, memo } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { Components, ExtraProps } from "streamdown";
import { uji } from "../uji.ts";
import { CodeBlock } from "./code-block.tsx";
import { proseStyles } from "./styles.stylex.ts";

type MarkdownPreProps = ComponentProps<"pre"> & ExtraProps;
type MarkdownTableProps = ComponentProps<"table"> & ExtraProps;

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function codeLanguage(className: string | undefined): string {
  for (const name of className?.split(/\s+/u) ?? []) {
    if (name.startsWith("language-")) return name.slice("language-".length);
  }
  return "";
}

function MarkdownPre({
  children,
  className: _className,
  node: _node,
  ...props
}: MarkdownPreProps): ReactElement {
  const child = Children.toArray(children)[0];
  if (Children.count(children) === 1 && isValidElement<ComponentProps<"code">>(child)) {
    const raw = nodeText(child.props.children);
    const code = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    return <CodeBlock code={code} lang={codeLanguage(child.props.className)} />;
  }
  return (
    <pre {...props} data-uji-scrollport {...stylex.props(proseStyles.fallbackPre)}>
      {children}
    </pre>
  );
}

function MarkdownTable({
  children,
  className: _className,
  node: _node,
  ...props
}: MarkdownTableProps): ReactElement {
  return (
    <div data-uji-scrollport {...stylex.props(proseStyles.tableWrap)}>
      <table {...props} {...stylex.props(proseStyles.table)}>
        {children}
      </table>
    </div>
  );
}

const markdownComponents = {
  p: ({ node: _node, className: _className, ...props }) => (
    <p {...props} {...stylex.props(proseStyles.measure, proseStyles.paragraph)} />
  ),
  h1: ({ node: _node, className: _className, ...props }) => (
    <h1 {...props} {...stylex.props(proseStyles.measure, proseStyles.heading, proseStyles.h1)} />
  ),
  h2: ({ node: _node, className: _className, ...props }) => (
    <h2 {...props} {...stylex.props(proseStyles.measure, proseStyles.heading, proseStyles.h2)} />
  ),
  h3: ({ node: _node, className: _className, ...props }) => (
    <h3 {...props} {...stylex.props(proseStyles.measure, proseStyles.heading, proseStyles.h3)} />
  ),
  h4: ({ node: _node, className: _className, ...props }) => (
    <h4 {...props} {...stylex.props(proseStyles.measure, proseStyles.heading, proseStyles.h4)} />
  ),
  h5: ({ node: _node, className: _className, ...props }) => (
    <h5 {...props} {...stylex.props(proseStyles.measure, proseStyles.heading, proseStyles.h4)} />
  ),
  h6: ({ node: _node, className: _className, ...props }) => (
    <h6 {...props} {...stylex.props(proseStyles.measure, proseStyles.heading, proseStyles.h4)} />
  ),
  strong: ({ node: _node, className: _className, ...props }) => (
    <strong {...props} {...stylex.props(proseStyles.strong)} />
  ),
  inlineCode: ({ node: _node, className: _className, ...props }) => (
    <code {...props} {...stylex.props(proseStyles.inlineCode)} />
  ),
  a: ({ node: _node, className: _className, onClick: _onClick, href, ...props }) => (
    <a
      {...props}
      href={href}
      title={href}
      {...stylex.props(proseStyles.link)}
      onClick={(event) => {
        if (href === undefined) return;
        event.preventDefault();
        void uji.host.openExternal({ url: href }).catch(() => undefined);
      }}
    />
  ),
  ul: ({ node: _node, className: _className, ...props }) => (
    <ul {...props} {...stylex.props(proseStyles.measure, proseStyles.list)} />
  ),
  ol: ({ node: _node, className: _className, ...props }) => (
    <ol {...props} {...stylex.props(proseStyles.measure, proseStyles.list)} />
  ),
  li: ({ node: _node, className: _className, ...props }) => (
    <li {...props} {...stylex.props(proseStyles.listItem)} />
  ),
  blockquote: ({ node: _node, className: _className, ...props }) => (
    <blockquote {...props} {...stylex.props(proseStyles.measure, proseStyles.blockquote)} />
  ),
  hr: ({ node: _node, className: _className, ...props }) => (
    <hr {...props} {...stylex.props(proseStyles.rule)} />
  ),
  pre: MarkdownPre,
  table: MarkdownTable,
  th: ({ node: _node, className: _className, ...props }) => (
    <th {...props} {...stylex.props(proseStyles.cell, proseStyles.headerCell)} />
  ),
  td: ({ node: _node, className: _className, ...props }) => (
    <td {...props} {...stylex.props(proseStyles.cell)} />
  ),
  img: ({ node: _node, className: _className, alt, title: _title, ..._props }) => (
    <span {...stylex.props(proseStyles.imageLabel)}>{alt ?? "image"}</span>
  ),
} satisfies Components;

const proseClassName = stylex.props(proseStyles.root).className;

export const Prose = memo(function Prose({
  markdown,
  streaming = false,
}: {
  markdown: string;
  streaming?: boolean;
}): ReactElement {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      animated={false}
      components={markdownComponents}
      controls={false}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
      skipHtml
      className={proseClassName}
    >
      {markdown}
    </Streamdown>
  );
});
