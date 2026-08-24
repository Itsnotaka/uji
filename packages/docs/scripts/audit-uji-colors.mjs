#!/usr/bin/env node

/**
 * Validates the product palette in src/lib/brand.ts.
 *
 * Site chrome is native Fumadocs (`--color-fd-*`). This script does not
 * require `--color-uji-*` CSS variables or fd→uji remaps. brand.ts is the
 * source of swatch hexes the /branding page renders.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const brandPath = path.join(scriptDir, "../src/lib/brand.ts");

if (!fs.existsSync(brandPath)) {
  throw new Error(`Required file not found: ${brandPath}`);
}

const expectedSwatches = [
  { name: "Base", source: "bg/base", light: "#fcfcfc", dark: "#070707" },
  { name: "Subtle", source: "bg/subtle", light: "#f7f7f7", dark: "#111111" },
  { name: "Elevated", source: "bg/elevated", light: "#fcfcfc", dark: "#181818" },
  { name: "Fill", source: "fill/secondary", light: "#77777717", dark: "#7777772c" },
  { name: "Selected", source: "fill/ghost-selected", light: "#7777772b", dark: "#77777752" },
  { name: "Border", source: "border/default", light: "#14141426", dark: "#fcfcfc26" },
  { name: "Secondary", source: "text/secondary", light: "#14141499", dark: "#fcfcfc99" },
  { name: "Primary", source: "text/primary", light: "#141414", dark: "#fcfcfc" },
  { name: "Accent text", source: "text/accent", light: "#0c64c1", dark: "#80befe" },
  { name: "Accent fill", source: "fill/accent", light: "#1084fe", dark: "#1084fe" },
];

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

if (swatches.size !== expectedSwatches.length) {
  errors.push(`Expected ${expectedSwatches.length} swatches, found ${swatches.size}`);
}

for (const name of swatches.keys()) {
  if (!expectedSwatches.some((role) => role.name === name)) {
    errors.push(`Unexpected brand swatch: ${name}`);
  }
}

for (const role of expectedSwatches) {
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

if (errors.length > 0) {
  console.error("Uji color audit failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Uji color audit passed (${expectedSwatches.length} brand.ts swatches).`);
  for (const role of expectedSwatches) {
    console.log(
      `${role.source.padEnd(20)} ${role.light.toUpperCase()}  ${role.dark.toUpperCase()}`,
    );
  }
}
