import { bold, fg, italic, underline, type TextChunk } from "@opentui/core";
import {
  bundledLanguages,
  codeToTokens,
  type BundledLanguage,
  type ThemeRegistration,
} from "shiki";
import type { CliTheme } from "./theme.ts";

const languageAliases: Readonly<Record<string, string>> = {
  javascriptreact: "jsx",
  typescriptreact: "tsx",
};

const themes = new WeakMap<CliTheme, ThemeRegistration>();

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language);
}

function bundledLanguage(filetype: string): BundledLanguage | undefined {
  const language = languageAliases[filetype] ?? filetype;
  return isBundledLanguage(language) ? language : undefined;
}

function shikiTheme(theme: CliTheme): ThemeRegistration {
  const existing = themes.get(theme);
  if (existing !== undefined) return existing;
  const value: ThemeRegistration = {
    name: "uji-terminal",
    type: "dark",
    fg: theme.foreground,
    bg: theme.codeBackground,
    settings: [
      { settings: { foreground: theme.foreground, background: theme.codeBackground } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: theme.dim, fontStyle: "italic" },
      },
      {
        scope: ["string", "string.quoted", "string.template", "constant.other.symbol"],
        settings: { foreground: theme.string },
      },
      {
        scope: ["constant.numeric", "constant.language", "constant.character"],
        settings: { foreground: theme.number },
      },
      {
        scope: ["keyword", "storage.modifier", "storage.type"],
        settings: { foreground: theme.code },
      },
      {
        scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
        settings: { foreground: theme.type },
      },
      {
        scope: ["entity.name.function", "support.function"],
        settings: { foreground: theme.user },
      },
      {
        scope: ["keyword.operator", "punctuation.separator", "punctuation.terminator"],
        settings: { foreground: theme.operator },
      },
      {
        scope: ["punctuation", "meta.brace", "meta.delimiter"],
        settings: { foreground: theme.dim },
      },
      { scope: ["invalid", "invalid.illegal"], settings: { foreground: theme.error } },
      { scope: ["markup.heading", "markup.bold"], settings: { fontStyle: "bold" } },
      { scope: "markup.italic", settings: { fontStyle: "italic" } },
      { scope: "markup.underline", settings: { fontStyle: "underline" } },
      { scope: "markup.raw", settings: { foreground: theme.code } },
    ],
  };
  themes.set(theme, value);
  return value;
}

function tokenChunk(
  content: string,
  color: string | undefined,
  fontStyle: number | undefined,
  fallback: string,
): TextChunk {
  let chunk = fg(color ?? fallback)(content);
  if (fontStyle !== undefined && (fontStyle & 1) !== 0) chunk = italic(chunk);
  if (fontStyle !== undefined && (fontStyle & 2) !== 0) chunk = bold(chunk);
  if (fontStyle !== undefined && (fontStyle & 4) !== 0) chunk = underline(chunk);
  return chunk;
}

/** Tokenize known source languages with Shiki without changing the source text. */
export async function syntaxHighlightedChunks(
  content: string,
  filetype: string,
  theme: CliTheme,
): Promise<TextChunk[] | undefined> {
  const language = bundledLanguage(filetype);
  if (language === undefined) return undefined;
  try {
    const result = await codeToTokens(content, {
      lang: language,
      theme: shikiTheme(theme),
    });
    const chunks: TextChunk[] = [];
    for (const [lineIndex, line] of result.tokens.entries()) {
      for (const token of line) {
        chunks.push(tokenChunk(token.content, token.color, token.fontStyle, theme.foreground));
      }
      if (lineIndex < result.tokens.length - 1) chunks.push(fg(theme.foreground)("\n"));
    }
    return chunks;
  } catch {
    return undefined;
  }
}
