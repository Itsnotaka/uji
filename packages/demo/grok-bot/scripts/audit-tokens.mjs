#!/usr/bin/env node
// Token and renderer-architecture lint for the grok-bot demo. Replaces the retired
// Grok Bot bundle-parity audit: the theme is now June's own; what must hold is the
// discipline, not the pixel values.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const uiSourceDir = path.join(repoRoot, "packages/ui/src");
const demoSourceDir = path.join(repoRoot, "packages/demo/grok-bot/src");
const tokensPath = path.join(uiSourceDir, "platform-tokens.stylex.ts");
const prepaintPath = path.join(demoSourceDir, "main/index.ts");

const errors = [];

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

function relative(file) {
  return path.relative(repoRoot, file);
}

const tokensSource = fs.readFileSync(tokensPath, "utf8");
const definedTokens = new Set(
  [...tokensSource.matchAll(/"(--june-[a-z0-9-]+)"\s*:/g)].map((match) => match[1]),
);
definedTokens.add("--june-font-family-ui");

const backgroundToken = tokensSource.match(
  /"--june-color-background":\s*"light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)"/i,
);
if (!backgroundToken) {
  errors.push("Could not read --june-color-background from platform-tokens.stylex.ts");
}
const prepaintAllowed = new Set(
  backgroundToken ? [backgroundToken[1].toLowerCase(), backgroundToken[2].toLowerCase()] : [],
);

const rawColorPattern = /#[0-9a-f]{3,8}\b|rgba?\s*\(/gi;
const demoFiles = walkFiles(demoSourceDir);

for (const file of demoFiles) {
  const source = fs.readFileSync(file, "utf8");
  const matches = [...source.matchAll(rawColorPattern)].map((match) => match[0].toLowerCase());
  if (matches.length === 0) continue;
  // Native prepaint cannot consume CSS variables; it must mirror the background token pair.
  if (file === prepaintPath && matches.every((color) => prepaintAllowed.has(color))) continue;
  errors.push(`${relative(file)} contains raw renderer colors: ${matches.join(", ")}`);
}

const referencedTokens = new Set();
for (const file of [...walkFiles(uiSourceDir), ...demoFiles]) {
  if (file.endsWith("platform-tokens.stylex.ts") || file.endsWith("platform-tokens.css")) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const [, name] of source.matchAll(/(--june-[a-z0-9-]+)/g)) {
    referencedTokens.add(name);
    if (!definedTokens.has(name)) {
      errors.push(`${relative(file)} references undefined token ${name}`);
    }
  }
}
for (const name of definedTokens) {
  if (name.startsWith("--june-color-") && !referencedTokens.has(name)) {
    errors.push(`Dead color token (defined, never referenced): ${name}`);
  }
}

const bannedPatterns = [
  [/\buseEffect\b/, "useEffect (the renderer is effect-free by design)"],
  [/data-grok-surface/, "data-grok-surface (retired audit hook)"],
  [/noFocusRing/, "noFocusRing (focus-visible must stay intact)"],
  [
    /\btext-\[\d+px\]|\bleading-\[\d+px\]|\bfont-\[\d+\]/,
    "arbitrary type utilities (use the token scale)",
  ],
  [/from "@base-ui\//, "direct @base-ui import (go through @june/ui)"],
  [
    / as unknown\b| as const\b|[)\]}] as [A-Z]|= [\w$.()[\]]+ as [A-Z]/,
    "an `as` assertion (narrow or parse instead)",
  ],
];
const importRename = /^\s*(?:import\b|(?:type\s+)?[\w$]+ as [\w$]+,?\s*$|.*\bfrom\s+["'])/;
for (const file of demoFiles) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const [pattern, label] of bannedPatterns) {
    const hit = lines.some((line) => pattern.test(line) && !importRename.test(line));
    if (hit) errors.push(`${relative(file)} uses ${label}`);
  }
}

if (errors.length > 0) {
  console.error("grok-bot token audit failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `grok-bot token audit passed (${definedTokens.size} tokens, ${demoFiles.length} renderer files clean)`,
  );
}
