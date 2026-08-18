#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const asarPath =
  process.env.GROK_BOT_ASAR ?? "/Applications/Grok Bot.app/Contents/Resources/app.asar";
const cssPath = path.join(scriptDir, "../src/app/global.css");
const brandPath = path.join(scriptDir, "../src/lib/brand.ts");

for (const file of [asarPath, cssPath, brandPath]) {
  if (!fs.existsSync(file)) {
    throw new Error(`Required file not found: ${file}`);
  }
}

const asarSource = fs.readFileSync(asarPath).toString("utf8");
const themeStart = asarSource.indexOf("const f2={gray:{light:{solid:[");

if (themeStart < 0) {
  throw new Error(`Could not find Grok Bot's compiled StyleX palette in ${asarPath}`);
}

// The palette, semantic aliases, and shadow roles are emitted together in the
// renderer bundle. Keeping this window small avoids treating unrelated app
// colors as design-system tokens.
const themeSource = asarSource.slice(themeStart, themeStart + 30_000);

function parseStringArray(source) {
  return JSON.parse(`[${source}]`);
}

function matchOrThrow(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not extract ${label} from Grok Bot's renderer bundle`);
  return match;
}

function readScale(name) {
  const match = matchOrThrow(
    themeSource,
    new RegExp(
      `${name}:\\{light:\\{solid:\\[([^\\]]+)\\],alpha:\\[([^\\]]+)\\]\\},dark:\\{solid:\\[([^\\]]+)\\],alpha:\\[([^\\]]+)\\]\\}\\}`,
    ),
    `${name} scale`,
  );

  return {
    light: { solid: parseStringArray(match[1]), alpha: parseStringArray(match[2]) },
    dark: { solid: parseStringArray(match[3]), alpha: parseStringArray(match[4]) },
  };
}

const gray = readScale("gray");
const blue = readScale("blue");
const neutralMatch = matchOrThrow(
  themeSource,
  /const iZ=\{solid:"(#[0-9a-f]{6})",alpha:\[([^\]]+)\]\},l2=\{solid:"(#[0-9a-f]{6})",alpha:\[([^\]]+)\]\}/,
  "black and white neutral scales",
);
const black = { solid: neutralMatch[1], alpha: parseStringArray(neutralMatch[2]) };
const white = { solid: neutralMatch[3], alpha: parseStringArray(neutralMatch[4]) };

const step = (scale, number) => scale[number - 1];

const colorRoles = [
  {
    name: "Base",
    source: "bg/base",
    cssVar: "--color-june-paper",
    light: white.solid,
    dark: step(gray.dark.solid, 1),
  },
  {
    name: "Subtle",
    source: "bg/subtle",
    cssVar: "--color-june-surface",
    light: step(gray.light.solid, 2),
    dark: step(gray.dark.solid, 2),
  },
  {
    name: "Elevated",
    source: "bg/elevated",
    cssVar: "--color-june-elevated",
    light: white.solid,
    dark: step(gray.dark.solid, 4),
  },
  {
    name: "Fill",
    source: "fill/secondary",
    cssVar: "--color-june-fill",
    light: step(gray.light.alpha, 3),
    dark: step(gray.dark.alpha, 3),
  },
  {
    name: "Selected",
    source: "fill/ghost-selected",
    cssVar: "--color-june-selection",
    light: step(gray.light.alpha, 5),
    dark: step(gray.dark.alpha, 5),
  },
  {
    name: "Border",
    source: "border/default",
    cssVar: "--color-june-rule",
    light: step(black.alpha, 3),
    dark: step(white.alpha, 3),
  },
  {
    name: "Secondary",
    source: "text/secondary",
    cssVar: "--color-june-muted",
    light: step(black.alpha, 8),
    dark: step(white.alpha, 8),
  },
  {
    name: "Primary",
    source: "text/primary",
    cssVar: "--color-june-ink",
    light: black.solid,
    dark: white.solid,
  },
  {
    name: "Accent text",
    source: "text/accent",
    cssVar: "--color-june-signal",
    light: step(blue.light.solid, 10),
    dark: step(blue.dark.solid, 11),
  },
  {
    name: "Accent fill",
    source: "fill/accent",
    cssVar: "--color-june-signal-fill",
    light: step(blue.light.solid, 9),
    dark: step(blue.dark.solid, 9),
  },
];

function readShadow(sourceName, cssName) {
  const match = matchOrThrow(
    themeSource,
    new RegExp(`Ct\\("${sourceName}",wd\\("(#[0-9a-f]{8})","(#[0-9a-f]{8})"`),
    sourceName,
  );
  return { cssVar: cssName, light: match[1], dark: match[2] };
}

const shadowRoles = [
  readShadow("shadow/control", "--color-june-shadow-control"),
  readShadow("shadow/inline/ambient", "--color-june-shadow-ambient"),
  readShadow("shadow/inline/key", "--color-june-shadow-key"),
  readShadow("shadow/ring", "--color-june-shadow-ring"),
];

function extractBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker} in ${cssPath}`);
  const openIndex = source.indexOf("{", markerIndex);
  let depth = 0;

  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }

  throw new Error(`Unclosed ${marker} block in ${cssPath}`);
}

function readDeclarations(block) {
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

const cssSource = fs.readFileSync(cssPath, "utf8");
const lightCss = readDeclarations(extractBlock(cssSource, "@theme"));
const darkCss = readDeclarations(extractBlock(cssSource, ".dark"));
const brandSource = fs.readFileSync(brandPath, "utf8");
const swatches = new Map(
  [
    ...brandSource.matchAll(
      /\{\s*name:\s*["']([^"']+)["'],\s*source:\s*["']([^"']+)["'],\s*role:\s*["'][^"']+["'],\s*light:\s*["'](#[0-9a-f]+)["'],\s*dark:\s*["'](#[0-9a-f]+)["']/gi,
    ),
  ].map((match) => [match[1], { source: match[2], light: match[3], dark: match[4] }]),
);

const errors = [];
const equalColor = (left, right) => left?.toLowerCase() === right.toLowerCase();
const colorModes = [
  { name: "light", declarations: lightCss },
  { name: "dark", declarations: darkCss },
];

for (const role of [...colorRoles, ...shadowRoles]) {
  for (const { name: mode, declarations } of colorModes) {
    const actual = declarations.get(role.cssVar);
    if (!equalColor(actual, role[mode])) {
      errors.push(`${mode} ${role.cssVar}: expected ${role[mode]}, found ${actual ?? "missing"}`);
    }
  }
}

for (const role of colorRoles) {
  const swatch = swatches.get(role.name);
  if (!swatch) {
    errors.push(`Brand swatch missing: ${role.name}`);
    continue;
  }
  if (swatch.source !== role.source) {
    errors.push(`${role.name} source: expected ${role.source}, found ${swatch.source}`);
  }
  if (!equalColor(swatch.light, role.light)) {
    errors.push(`${role.name} light swatch: expected ${role.light}, found ${swatch.light}`);
  }
  if (!equalColor(swatch.dark, role.dark)) {
    errors.push(`${role.name} dark swatch: expected ${role.dark}, found ${swatch.dark}`);
  }
}

const fumaMappings = new Map([
  ["--color-fd-border", "var(--color-june-rule)"],
  ["--color-fd-card", "var(--color-june-elevated)"],
  ["--color-fd-popover", "var(--color-june-elevated)"],
  ["--color-fd-secondary", "var(--color-june-fill)"],
  ["--color-fd-accent", "var(--color-june-selection)"],
  ["--color-fd-primary", "var(--color-june-signal)"],
  ["--color-fd-ring", "var(--color-june-signal-fill)"],
]);

for (const [name, expected] of fumaMappings) {
  for (const { name: mode, declarations } of colorModes) {
    const actual = declarations.get(name);
    if (actual !== expected) {
      errors.push(`${mode} ${name}: expected ${expected}, found ${actual ?? "missing"}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Grok Bot color audit failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Grok Bot color audit passed (${colorRoles.length} colors, ${shadowRoles.length} shadows).`,
  );
  for (const role of colorRoles) {
    console.log(
      `${role.source.padEnd(20)} ${role.light.toUpperCase()}  ${role.dark.toUpperCase()}`,
    );
  }
}
