#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const asarPath =
  process.env.GROK_BOT_ASAR ?? "/Applications/Grok Bot.app/Contents/Resources/app.asar";
const platformStylexPath = path.join(repoRoot, "packages/ui/src/platform-tokens.stylex.ts");
const platformCssPath = path.join(repoRoot, "packages/ui/src/platform-tokens.css");
const demoSourcePath = path.join(repoRoot, "packages/demo/grok-bot/src");
const websiteSourcePath = path.join(repoRoot, "packages/demo/website/src");
const appSourcePath = path.join(demoSourcePath, "App.tsx");
const sidebarSourcePath = path.join(demoSourcePath, "components/sidebar.tsx");
const detailsSourcePath = path.join(demoSourcePath, "components/bot-details.tsx");
const paletteSourcePath = path.join(demoSourcePath, "components/search-palette.tsx");
const dialogSourcePath = path.join(repoRoot, "packages/ui/src/components/ui/dialog.tsx");
const iconBoxSourcePath = path.join(repoRoot, "packages/ui/src/components/ui/icon-box.tsx");

for (const file of [asarPath, platformStylexPath, platformCssPath]) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const asarSource = fs.readFileSync(asarPath, "utf8");
const themeStart = asarSource.indexOf("const f2={gray:{light:{solid:[");
if (themeStart < 0) throw new Error(`Could not find Grok Bot's StyleX palette in ${asarPath}`);
const themeSource = asarSource.slice(themeStart, themeStart + 30_000);

function matchOrThrow(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not extract ${label}`);
  return match;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readCompiledDeclaration(className, property) {
  return matchOrThrow(
    asarSource,
    new RegExp(`${escapeRegex(className)}[^\\{]*\\{[^}]*${property}:([^;}]+)`),
    `${property} for ${className}`,
  )[1];
}

function readDeclarationFromClasses(classNames, property) {
  for (const className of classNames.split(" ")) {
    const match = asarSource.match(
      new RegExp(`${escapeRegex(className)}[^\\{]*\\{[^}]*${property}:([^;}]+)`),
    );
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`Could not extract ${property} from ${classNames}`);
}

function resolveBundleValue(value) {
  const variable = value.match(/^var\((--[a-z0-9-]+)\)$/i)?.[1];
  if (variable === undefined) return value.trim();
  const declarations = [
    ...asarSource.matchAll(new RegExp(`${escapeRegex(variable)}:([^;}]+)`, "g")),
  ];
  const resolved = declarations.at(-1)?.[1]?.trim();
  if (resolved === undefined) throw new Error(`Could not resolve ${variable}`);
  return resolved;
}

function cssLengthPx(value) {
  if (value.endsWith("px")) return Number.parseFloat(value);
  if (value.endsWith("rem")) return Number.parseFloat(value) * 16;
  throw new Error(`Unsupported measured CSS length: ${value}`);
}

function parseStringArray(source) {
  return JSON.parse(`[${source}]`);
}

function readScale(name) {
  const match = matchOrThrow(
    themeSource,
    new RegExp(
      `${name}:\\{light:\\{solid:\\[([^\\]]+)\\],alpha:\\[([^\\]]+)\\]\\},dark:\\{solid:\\[([^\\]]+)\\],alpha:\\[([^\\]]+)\\]\\}\\}`,
    ),
    `${name} scale from ${asarPath}`,
  );
  return {
    light: { solid: parseStringArray(match[1]), alpha: parseStringArray(match[2]) },
    dark: { solid: parseStringArray(match[3]), alpha: parseStringArray(match[4]) },
  };
}

const gray = readScale("gray");
const blue = readScale("blue");
const red = readScale("red");
const orange = readScale("orange");
const yellow = readScale("yellow");
const green = readScale("green");
const purple = readScale("purple");
const neutralMatch = matchOrThrow(
  themeSource,
  /const iZ=\{solid:"(#[0-9a-f]{6})",alpha:\[([^\]]+)\]\},l2=\{solid:"(#[0-9a-f]{6})",alpha:\[([^\]]+)\]\}/,
  `neutral scales from ${asarPath}`,
);
const black = { solid: neutralMatch[1], alpha: parseStringArray(neutralMatch[2]) };
const white = { solid: neutralMatch[3], alpha: parseStringArray(neutralMatch[4]) };
const step = (values, number) => values[number - 1];
const lightDark = (light, dark) => `light-dark(${light}, ${dark})`;

function readBundleHex(name) {
  return matchOrThrow(
    asarSource,
    new RegExp(`${escapeRegex(name)}:(#[0-9a-f]{6,8})`, "i"),
    `${name} from ${asarPath}`,
  )[1].toLowerCase();
}

function withAlpha(hex, ratio) {
  return `${hex.slice(0, 7)}${Math.round(255 * ratio)
    .toString(16)
    .padStart(2, "0")}`;
}

const commandBackground = readBundleHex("--cursor-editor");
const commandBase = readBundleHex("--cursor-base");
const commandScrim = readBundleHex("--sand-bg-scrim");
const commandShadowSource = matchOrThrow(
  asarSource,
  /--cursor-box-shadow-lg:([^;}]+)/,
  `command palette shadow from ${asarPath}`,
)[1];
const commandInsetRatio = Number(
  matchOrThrow(commandShadowSource, /rgba\(255, 255, 255, ([\d.]+)\)/, "command inset alpha")[1],
);
const commandPrimaryRatio =
  Number(
    matchOrThrow(
      asarSource,
      /--cursor-shadow-primary:color-mix\(in srgb, #000000 (\d+)%, transparent\)/,
      "command primary shadow ratio",
    )[1],
  ) / 100;
const commandSecondaryRatio =
  Number(
    matchOrThrow(
      asarSource,
      /--cursor-shadow-secondary:color-mix\(in srgb, var\(--cursor-shadow-primary\) (\d+)%, transparent\)/,
      "command secondary shadow ratio",
    )[1],
  ) / 100;
const commandTertiaryRatio =
  Number(
    matchOrThrow(
      asarSource,
      /--cursor-shadow-tertiary:color-mix\(in srgb, var\(--cursor-shadow-primary\) (\d+)%, transparent\)/,
      "command tertiary shadow ratio",
    )[1],
  ) / 100;
const commandShadow = commandShadowSource
  .replace(/rgba\(255, 255, 255, [\d.]+\)/, withAlpha("#ffffff", commandInsetRatio))
  .replace(
    "var(--cursor-shadow-secondary)",
    withAlpha("#000000", commandPrimaryRatio * commandSecondaryRatio),
  )
  .replace(
    "var(--cursor-shadow-tertiary)",
    withAlpha("#000000", commandPrimaryRatio * commandTertiaryRatio),
  );

const layoutMatch = matchOrThrow(
  asarSource,
  /const [\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=(\d+),[\w$]+=\{slice:"ui-layout"/,
  `layout measurements from ${asarPath}`,
);
const measuredLayout = {
  sidebarDefault: Number(layoutMatch[1]),
  sidebarMin: Number(layoutMatch[2]),
  sidebarMax: Number(layoutMatch[3]),
  sidebarCollapsed: Number(layoutMatch[4]),
  detailsDefault: Number(layoutMatch[5]),
  detailsMin: Number(layoutMatch[6]),
  detailsMax: Number(layoutMatch[7]),
  conversationMin: Number(layoutMatch[8]),
};
const smallIconClass = matchOrThrow(
  asarSource,
  /sizeSm:\{"--icon-size":"([^"]+)"/,
  `small icon class from ${asarPath}`,
)[1];
const smallIconPx = cssLengthPx(readCompiledDeclaration(smallIconClass, "--icon-size"));
const paletteClasses = matchOrThrow(
  asarSource,
  /const [\w$]+=360,[\w$]+=42,[\w$]+=[\w$]+\+[\w$]+,[\w$]+=\{dialog:\{kzqmXN:"([^"]+)",ks0D6T:"([^"]+)",kGVxlE:"([^"]+)",kaIpWk:"([^"]+)",kMzoRj:"([^"]+)"/,
  `command palette geometry from ${asarPath}`,
);
const paletteWidth = readCompiledDeclaration(paletteClasses[1], "width");
const paletteMaxWidth = readCompiledDeclaration(paletteClasses[2], "max-width");
const paletteShadowReference = readCompiledDeclaration(paletteClasses[3], "box-shadow");
const paletteRadiusReference = readCompiledDeclaration(paletteClasses[4], "border-radius");
const paletteBorderWidth = readCompiledDeclaration(paletteClasses[5], "border-width");
const paletteHeaderClasses = matchOrThrow(
  asarSource,
  /p\.jsxs\(DX,\{"aria-label":"Search"[^]{0,2500}?children:\[p\.jsxs\("div",\{className:"([^"]+)"/,
  `command palette header classes from ${asarPath}`,
)[1];
const paletteHeaderGap = resolveBundleValue(
  readDeclarationFromClasses(paletteHeaderClasses, "gap"),
);
const paletteHeaderPadding = {
  top: resolveBundleValue(readDeclarationFromClasses(paletteHeaderClasses, "padding-top")),
  right: resolveBundleValue(readDeclarationFromClasses(paletteHeaderClasses, "padding-right")),
  bottom: resolveBundleValue(readDeclarationFromClasses(paletteHeaderClasses, "padding-bottom")),
  left: resolveBundleValue(readDeclarationFromClasses(paletteHeaderClasses, "padding-left")),
};
const paletteListClasses = matchOrThrow(
  asarSource,
  /list:\{khm7nJ:"([^"]+)",kLKAdn:"([^"]+)",kpe85a:"([^"]+)",kGO01o:"([^"]+)",kE3dHu:"([^"]+)"/,
  `command palette list classes from ${asarPath}`,
);
const paletteListGap = resolveBundleValue(
  readCompiledDeclaration(paletteListClasses[1], "row-gap"),
);
const paletteListPadding = {
  top: resolveBundleValue(readCompiledDeclaration(paletteListClasses[2], "padding-top")),
  right: resolveBundleValue(readCompiledDeclaration(paletteListClasses[3], "padding-right")),
  bottom: resolveBundleValue(readCompiledDeclaration(paletteListClasses[4], "padding-bottom")),
  left: resolveBundleValue(readCompiledDeclaration(paletteListClasses[5], "padding-left")),
};
const paletteRadiusMatches = [...asarSource.matchAll(/--cursor-radius-2xl:([^;}]+)/g)];
const paletteRadius = paletteRadiusMatches.at(-1)?.[1]?.trim();
if (paletteRadius === undefined) {
  throw new Error(`Could not extract command palette radius from ${asarPath}`);
}
if (paletteShadowReference !== "var(--cursor-box-shadow-lg)") {
  throw new Error(`Unexpected command palette shadow reference: ${paletteShadowReference}`);
}
if (paletteRadiusReference !== "var(--cursor-radius-2xl)") {
  throw new Error(`Unexpected command palette radius reference: ${paletteRadiusReference}`);
}
const paletteDuration = Number(
  matchOrThrow(
    asarSource,
    /rootStylexStyles:[\w$]+,transitionDuration:(\d+)/,
    `command palette transition duration from ${asarPath}`,
  )[1],
);

// Every value below follows one of Grok Bot's compiled semantic aliases. The
// mapping names June's component roles; the values are derived from the bundle,
// never copied into this verifier as expected hex literals.
const expectedColors = new Map([
  ["--june-color-background", lightDark(white.solid, step(gray.dark.solid, 1))],
  ["--june-color-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-surface", lightDark(white.solid, step(gray.dark.solid, 1))],
  ["--june-color-surface-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-popover", lightDark(white.solid, step(gray.dark.solid, 4))],
  ["--june-color-popover-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-command-background", commandBackground],
  ["--june-color-command-border", withAlpha(commandBase, 0.12)],
  ["--june-color-command-divider", withAlpha(commandBase, 0.08)],
  ["--june-color-command-scrim", commandScrim],
  ["--june-color-primary", lightDark(step(gray.dark.solid, 1), step(gray.light.solid, 1))],
  ["--june-color-primary-hover", lightDark(step(gray.dark.solid, 6), step(gray.light.solid, 6))],
  ["--june-color-primary-foreground", lightDark(white.solid, black.solid)],
  ["--june-color-secondary", lightDark(step(gray.light.alpha, 3), step(gray.dark.alpha, 3))],
  ["--june-color-secondary-hover", lightDark(step(gray.light.alpha, 5), step(gray.dark.alpha, 5))],
  ["--june-color-secondary-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-muted", lightDark(step(gray.light.alpha, 3), step(gray.dark.alpha, 3))],
  ["--june-color-muted-foreground", lightDark(step(black.alpha, 8), step(white.alpha, 8))],
  ["--june-color-tertiary-foreground", lightDark(step(black.alpha, 6), step(white.alpha, 6))],
  ["--june-color-accent", lightDark(step(gray.light.alpha, 5), step(gray.dark.alpha, 5))],
  ["--june-color-accent-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-destructive", lightDark(step(red.light.solid, 10), step(red.dark.solid, 11))],
  ["--june-color-destructive-muted", lightDark(step(red.light.alpha, 3), step(red.dark.alpha, 3))],
  ["--june-color-destructive-hover", lightDark(step(red.light.alpha, 5), step(red.dark.alpha, 5))],
  ["--june-color-destructive-foreground", lightDark(white.solid, white.solid)],
  ["--june-color-warning", lightDark(step(yellow.light.solid, 10), step(yellow.dark.solid, 11))],
  ["--june-color-border-weak", lightDark(step(black.alpha, 2), step(white.alpha, 2))],
  ["--june-color-border", lightDark(step(black.alpha, 3), step(white.alpha, 3))],
  ["--june-color-input", lightDark(step(black.alpha, 3), step(white.alpha, 3))],
  ["--june-color-field-background", lightDark(white.solid, step(gray.dark.solid, 6))],
  ["--june-color-field-disabled", lightDark(step(gray.light.solid, 3), step(gray.dark.solid, 3))],
  ["--june-color-ring", lightDark(step(black.alpha, 6), step(white.alpha, 6))],
  ["--june-color-scrim", lightDark(step(black.alpha, 7), step(black.alpha, 9))],
  ["--june-color-sidebar", lightDark(step(gray.light.solid, 2), step(gray.dark.solid, 2))],
  ["--june-color-sidebar-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-sidebar-accent", lightDark(step(gray.light.alpha, 5), step(gray.dark.alpha, 5))],
  ["--june-color-sidebar-accent-foreground", lightDark(black.solid, white.solid)],
  ["--june-color-sidebar-border", lightDark(step(black.alpha, 3), step(white.alpha, 3))],
  ["--june-color-bubble-agent", lightDark(step(gray.light.solid, 4), step(gray.dark.solid, 5))],
  ["--june-color-bubble-user", lightDark(step(gray.dark.solid, 1), step(gray.dark.solid, 8))],
  ["--june-color-bubble-user-foreground", lightDark(white.solid, white.solid)],
  [
    "--june-color-avatar-background",
    lightDark(step(gray.light.alpha, 3), step(gray.dark.alpha, 3)),
  ],
  [
    "--june-color-avatar-foreground",
    lightDark(step(gray.light.solid, 11), step(gray.dark.solid, 11)),
  ],
  [
    "--june-color-avatar-orange-background",
    lightDark(step(orange.light.alpha, 3), step(orange.dark.alpha, 3)),
  ],
  [
    "--june-color-avatar-orange-foreground",
    lightDark(step(orange.light.solid, 10), step(orange.dark.solid, 11)),
  ],
  [
    "--june-color-avatar-blue-background",
    lightDark(step(blue.light.alpha, 3), step(blue.dark.alpha, 3)),
  ],
  [
    "--june-color-avatar-blue-foreground",
    lightDark(step(blue.light.solid, 10), step(blue.dark.solid, 11)),
  ],
  [
    "--june-color-avatar-violet-background",
    lightDark(step(purple.light.alpha, 3), step(purple.dark.alpha, 3)),
  ],
  [
    "--june-color-avatar-violet-foreground",
    lightDark(step(purple.light.solid, 10), step(purple.dark.solid, 11)),
  ],
  [
    "--june-color-avatar-green-background",
    lightDark(step(green.light.alpha, 3), step(green.dark.alpha, 3)),
  ],
  [
    "--june-color-avatar-green-foreground",
    lightDark(step(green.light.solid, 10), step(green.dark.solid, 11)),
  ],
]);

const expectedElevations = new Map([
  [
    "--june-elevation-field",
    `0 4px 12px -1px ${lightDark("#00000014", "#00000000")}, 0 2px 4px -2px ${lightDark("#0000000f", "#00000000")}, 0 0 0 1px ${lightDark("#e4e4e40a", "#e4e4e400")}`,
  ],
  [
    "--june-elevation-menu",
    `0 10px 20px -3px ${lightDark("#0000001a", "#00000000")}, 0 4px 6px -4px ${lightDark("#0000001a", "#00000000")}, 0 0 0 1px ${lightDark("#e4e4e40a", "#e4e4e400")}`,
  ],
  [
    "--june-elevation-dialog",
    `0 22px 70px 4px ${lightDark("#0000008f", "#00000000")}, 0 0 0 .5px ${lightDark("#0000001a", "#00000000")}`,
  ],
  ["--june-elevation-command", commandShadow],
]);

function extractBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker}`);
  const openIndex = source.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  throw new Error(`Unclosed ${marker} block`);
}

function readQuotedDeclarations(block) {
  return new Map(
    [...block.matchAll(/"(--[a-z0-9-]+)"\s*:\s*"([^"]+)"/gi)].map((match) => [match[1], match[2]]),
  );
}

function readCssDeclarations(block) {
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

const platformStylexSource = fs.readFileSync(platformStylexPath, "utf8");
const platformCssSource = fs.readFileSync(platformCssPath, "utf8");
const stylexColors = readQuotedDeclarations(extractBlock(platformStylexSource, "colorDefaults ="));
const stylexRadii = readQuotedDeclarations(extractBlock(platformStylexSource, "radiusDefaults ="));
const stylexBorders = readQuotedDeclarations(
  extractBlock(platformStylexSource, "borderDefaults ="),
);
const stylexElevations = readQuotedDeclarations(
  extractBlock(platformStylexSource, "elevationDefaults ="),
);
const cssDefaults = readCssDeclarations(extractBlock(platformCssSource, ":root"));
const errors = [];

function requireSource(source, pattern, label) {
  if (!pattern.test(source)) errors.push(`${label} does not match Grok Bot`);
}

function forbidSource(source, pattern, label) {
  if (pattern.test(source)) errors.push(label);
}

const appSource = fs.readFileSync(appSourcePath, "utf8");
const sidebarSource = fs.readFileSync(sidebarSourcePath, "utf8");
const detailsSource = fs.readFileSync(detailsSourcePath, "utf8");
const paletteSource = fs.readFileSync(paletteSourcePath, "utf8");
const dialogSource = fs.readFileSync(dialogSourcePath, "utf8");
const iconBoxSource = fs.readFileSync(iconBoxSourcePath, "utf8");
requireSource(
  appSource,
  new RegExp(`const defaultSidebarWidth = ${measuredLayout.sidebarDefault};`),
  "default sidebar width",
);
requireSource(
  appSource,
  new RegExp(`const collapsedSidebarWidth = ${measuredLayout.sidebarCollapsed};`),
  "collapsed sidebar width",
);
requireSource(
  appSource,
  new RegExp(`const minimumConversationWidth = ${measuredLayout.conversationMin};`),
  "minimum conversation width",
);
requireSource(
  appSource,
  new RegExp(`const defaultDetailsWidth = ${measuredLayout.detailsDefault};`),
  "default details width",
);
requireSource(
  appSource,
  new RegExp(
    `Math\\.min\\(${measuredLayout.sidebarMax}, Math\\.max\\(${measuredLayout.sidebarMin}, width\\)\\)`,
  ),
  "sidebar resize bounds",
);
requireSource(
  appSource,
  new RegExp(
    `Math\\.min\\(${measuredLayout.detailsMax}, Math\\.max\\(${measuredLayout.detailsMin}, width\\)\\)`,
  ),
  "details resize bounds",
);
requireSource(
  sidebarSource,
  new RegExp(`<IconBox glyphSize=\\{${smallIconPx}\\}>\\s*<IconPlusMedium`),
  "new chat icon size",
);
requireSource(sidebarSource, /<IconBox>\s*<IconUser\s*\/>/, "account icon box");
forbidSource(
  sidebarSource,
  /^(?!.*<IconBox).*<Icon[A-Z][A-Za-z0-9]*\b[^>]*\bsize=/m,
  "sidebar renders an icon size outside IconBox",
);
requireSource(
  detailsSource,
  new RegExp(`<IconBox glyphSize=\\{${smallIconPx}\\}>\\s*<IconSidebarHiddenRightWide`),
  "details close icon size",
);
requireSource(
  dialogSource,
  new RegExp(`<IconBox glyphSize=\\{${smallIconPx}\\}>\\s*<IconCrossSmall`),
  "dialog close icon size",
);
requireSource(iconBoxSource, /width: "16px"/, "icon box width");
requireSource(iconBoxSource, /height: "16px"/, "icon box height");
requireSource(
  paletteSource,
  new RegExp(`width:\\s*${Number.parseFloat(paletteWidth)}`),
  "command palette width",
);
requireSource(
  paletteSource,
  new RegExp(`maxWidth:\\s*"${escapeRegex(paletteMaxWidth)}"`),
  "command palette maximum width",
);
requireSource(
  paletteSource,
  new RegExp(`motionDuration="${paletteDuration}ms"`),
  "command palette transition duration",
);
for (const [label, value] of [
  ["header gap", paletteHeaderGap],
  ["header top padding", paletteHeaderPadding.top],
  ["header right padding", paletteHeaderPadding.right],
  ["header bottom padding", paletteHeaderPadding.bottom],
  ["header left padding", paletteHeaderPadding.left],
  ["list row gap", paletteListGap],
  ["list top padding", paletteListPadding.top],
  ["list right padding", paletteListPadding.right],
  ["list bottom padding", paletteListPadding.bottom],
  ["list left padding", paletteListPadding.left],
]) {
  requireSource(paletteSource, new RegExp(`"${escapeRegex(value)}"`), `command palette ${label}`);
}
forbidSource(paletteSource, /<kbd\b/, "command palette includes a non-source keycap");
for (const token of [
  "--june-color-command-background",
  "--june-color-command-border",
  "--june-color-command-divider",
  "--june-color-command-scrim",
]) {
  requireSource(paletteSource, new RegExp(escapeRegex(token)), `command palette token ${token}`);
}
requireSource(
  paletteSource,
  /--june-elevation-command/,
  "command palette measured elevation token",
);

function checkExpected(label, expected, ...actualMaps) {
  for (const [name, value] of expected) {
    for (const [actualLabel, actual] of actualMaps) {
      if (actual.get(name)?.toLowerCase() !== value.toLowerCase()) {
        errors.push(
          `${label} ${name} in ${actualLabel}: expected ${value}, found ${actual.get(name) ?? "missing"}`,
        );
      }
    }
  }
}

checkExpected(
  "color",
  expectedColors,
  ["platform-tokens.stylex.ts", stylexColors],
  ["platform-tokens.css", cssDefaults],
);
checkExpected(
  "elevation",
  expectedElevations,
  ["platform-tokens.stylex.ts", stylexElevations],
  ["platform-tokens.css", cssDefaults],
);
checkExpected(
  "command radius",
  new Map([["--june-radius-dialog", paletteRadius]]),
  ["platform-tokens.stylex.ts", stylexRadii],
  ["platform-tokens.css", cssDefaults],
);
checkExpected(
  "command border width",
  new Map([["--june-border-hairline-width", paletteBorderWidth]]),
  ["platform-tokens.stylex.ts", stylexBorders],
  ["platform-tokens.css", cssDefaults],
);

for (const name of stylexColors.keys()) {
  if (!expectedColors.has(name)) errors.push(`Unverified StyleX color token: ${name}`);
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

const rawColorPattern = /#[0-9a-f]{3,8}\b|rgba?\s*\(/gi;
for (const file of walkFiles(demoSourcePath)) {
  const relative = path.relative(repoRoot, file);
  const source = fs.readFileSync(file, "utf8");
  const matches = [...source.matchAll(rawColorPattern)].map((match) => match[0].toLowerCase());
  const allowedNativePrepaint =
    relative === "packages/demo/grok-bot/src/main/index.ts" &&
    matches.length === 1 &&
    matches[0] === step(gray.dark.solid, 1);
  if (matches.length > 0 && !allowedNativePrepaint) {
    errors.push(`${relative} contains raw renderer colors: ${matches.join(", ")}`);
  }
}

for (const file of walkFiles(websiteSourcePath).filter((file) => file.endsWith(".tsx"))) {
  const source = fs.readFileSync(file, "utf8");
  const matches = [...source.matchAll(rawColorPattern)].map((match) => match[0]);
  if (matches.length > 0) {
    errors.push(
      `${path.relative(repoRoot, file)} contains raw preview colors: ${matches.join(", ")}`,
    );
  }
}

const websiteCss = readCssDeclarations(
  extractBlock(fs.readFileSync(path.join(websiteSourcePath, "styles.css"), "utf8"), "@theme"),
);
const websiteRoute = fs.readFileSync(path.join(websiteSourcePath, "routes/index.tsx"), "utf8");
const websiteScenarios = new Set(
  [...websiteRoute.matchAll(/\bscenario:\s*"([a-z-]+)"/g)].map((match) => match[1]),
);
for (const scenario of ["conversation", "search", "details"]) {
  if (!websiteScenarios.has(scenario)) errors.push(`Website showcase missing ${scenario} state`);
}
if (websiteScenarios.size !== 3) {
  errors.push(`Website showcase should contain exactly 3 states, found ${websiteScenarios.size}`);
}
const expectedWebsite = new Map([
  ["--color-ink", step(gray.dark.solid, 1)],
  ["--color-ink-foreground", white.solid],
  ["--color-paper", white.solid],
  ["--color-paper-foreground", black.solid],
  ["--color-accent", step(blue.dark.solid, 11)],
]);
checkExpected("website", expectedWebsite, ["website styles.css", websiteCss]);

if (errors.length > 0) {
  console.error("Grok Bot StyleX audit failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Grok Bot StyleX audit passed (${expectedColors.size} colors, ${expectedElevations.size} elevations, 8 layout measurements, 16px icon boxes with ${smallIconPx}px compact glyphs, ${paletteWidth}/${paletteMaxWidth} command palette, ${paletteRadius} radius, ${paletteBorderWidth} border, ${paletteDuration}ms palette motion, 2 demo consumers, ${websiteScenarios.size} website states).`,
  );
  for (const name of [
    "--june-color-background",
    "--june-color-sidebar",
    "--june-color-popover",
    "--june-color-field-background",
    "--june-color-bubble-agent",
    "--june-color-bubble-user",
    "--june-color-accent",
  ]) {
    console.log(`${name.padEnd(38)} ${expectedColors.get(name)}`);
  }
}
