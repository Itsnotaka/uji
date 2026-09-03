// Fenced code paints as escaped plain text immediately. Known grammars upgrade
// through an idle-loaded Shiki chunk, keeping syntax work out of thread clicks.
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Icon } from "../components/icons.tsx";
import { focus } from "../components/ui.tsx";
import { codeBlockStyles } from "./styles.stylex.ts";

const HIGHLIGHTABLE = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "c",
  "cpp",
  "c++",
  "cxx",
  "csharp",
  "cs",
  "css",
  "diff",
  "docker",
  "dockerfile",
  "go",
  "html",
  "htm",
  "java",
  "javascript",
  "js",
  "json",
  "jsonc",
  "jsx",
  "markdown",
  "md",
  "mdx",
  "php",
  "powershell",
  "ps1",
  "python",
  "py",
  "ruby",
  "rb",
  "rust",
  "rs",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "ts",
  "xml",
  "yaml",
  "yml",
]);

interface HighlightedCode {
  readonly code: string;
  readonly language: string;
  readonly html: string;
}

type HighlighterModule = typeof import("./syntax-highlighter.ts");

interface HighlightJob {
  cancelled: boolean;
  readonly run: (module: HighlighterModule) => void;
}

const highlightQueue: HighlightJob[] = [];
const HIGHLIGHT_CACHE_LIMIT = 64;
const highlightCache = new Map<string, HighlightedCode>();
let highlighter: HighlighterModule | undefined;
let highlighterLoading = false;
let highlighterFailed = false;
let highlightIdle: number | undefined;

function scheduleHighlightWork(): void {
  if (highlightIdle !== undefined || highlighterFailed) return;
  while (highlightQueue[0]?.cancelled === true) highlightQueue.shift();
  if (highlightQueue.length === 0) return;

  highlightIdle = window.requestIdleCallback(
    () => {
      highlightIdle = undefined;
      if (highlighter === undefined) {
        if (!highlighterLoading) {
          highlighterLoading = true;
          void import("./syntax-highlighter.ts")
            .then((module) => {
              highlighter = module;
            })
            .catch(() => {
              highlighterFailed = true;
              highlightQueue.length = 0;
            })
            .finally(() => {
              highlighterLoading = false;
              scheduleHighlightWork();
            });
        }
        return;
      }

      let job = highlightQueue.shift();
      while (job?.cancelled === true) job = highlightQueue.shift();
      job?.run(highlighter);
      // Never drain a long transcript in one frame.
      window.requestAnimationFrame(scheduleHighlightWork);
    },
    { timeout: 500 },
  );
}

function enqueueHighlight(run: HighlightJob["run"]): () => void {
  const job: HighlightJob = { cancelled: false, run };
  highlightQueue.push(job);
  scheduleHighlightWork();
  return () => {
    job.cancelled = true;
  };
}

function cachedHighlight(code: string, language: string): HighlightedCode | undefined {
  const key = `${String(language.length)}:${language}${code}`;
  return highlightCache.get(key);
}

function rememberHighlight(value: HighlightedCode): void {
  const key = `${String(value.language.length)}:${value.language}${value.code}`;
  highlightCache.delete(key);
  highlightCache.set(key, value);
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
}

export function CodeBlock({ code, lang }: { code: string; lang: string }): ReactElement {
  const language = lang.trim().toLowerCase().split(/\s+/u)[0] ?? "";
  const figure = useRef<HTMLElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [highlighted, setHighlighted] = useState<HighlightedCode | undefined>(() =>
    cachedHighlight(code, language),
  );
  const [copiedCode, setCopiedCode] = useState<string>();
  const copied = copiedCode === code;
  const cached = cachedHighlight(code, language);
  const html =
    highlighted?.code === code && highlighted.language === language
      ? highlighted.html
      : cached?.html;

  useEffect(() => {
    const element = figure.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport || !HIGHLIGHTABLE.has(language)) return;
    if (cachedHighlight(code, language) !== undefined) return;
    return enqueueHighlight(({ highlightCode }) => {
      const next = highlightCode(code, language);
      if (next !== undefined) {
        const value = { code, language, html: next };
        rememberHighlight(value);
        setHighlighted(value);
      }
    });
  }, [code, language, nearViewport]);

  return (
    <figure ref={figure} {...stylex.props(codeBlockStyles.figure)}>
      <div {...stylex.props(codeBlockStyles.toolbar)}>
        <span {...stylex.props(codeBlockStyles.language)}>
          {language === "" ? "code" : language}
        </span>
        <button
          type="button"
          aria-label={copied ? "Code copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(
              () => setCopiedCode(code),
              () => undefined,
            );
          }}
          {...stylex.props(codeBlockStyles.copy, focus.ringInset)}
        >
          <Icon name={copied ? "checkmark" : "copy"} size={13} />
        </button>
      </div>
      <div data-uji-scrollport {...stylex.props(codeBlockStyles.scroll)}>
        {html === undefined ? (
          <pre {...stylex.props(codeBlockStyles.pre)}>
            <code>{code}</code>
          </pre>
        ) : (
          <div
            {...stylex.props(codeBlockStyles.pre)}
            // Shiki output over escaped code; see module note.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </figure>
  );
}
