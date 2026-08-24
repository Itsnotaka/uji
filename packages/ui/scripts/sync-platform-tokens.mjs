import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "src/platform-tokens.stylex.ts");
const outputPath = join(packageRoot, "src/platform-tokens.css");
const check = process.argv.includes("--check");

const sourceText = await readFile(sourcePath, "utf8");
const declaredTokens = sourceText.match(/"--uji-[^"]+"\s*:/g) ?? [];
if (declaredTokens.length === 0) throw new Error("No literal Uji tokens found");

const tokenPattern =
  /"(?<name>--uji-[^"]+)"\s*:\s*(?:"(?<doubleQuoted>[^"\\]*)"|'(?<singleQuoted>[^'\\]*)'|(?<number>-?\d+(?:\.\d+)?)),/g;
const declarations = [...sourceText.matchAll(tokenPattern)].map(({ groups }) => {
  if (groups === undefined) throw new Error("Token parser invariant failed");
  const { name, doubleQuoted, singleQuoted, number } = groups;
  const value = doubleQuoted ?? singleQuoted ?? number;
  if (name === undefined || value === undefined) throw new Error("Token parser invariant failed");
  return `  ${name}: ${value};`;
});

if (declarations.length !== declaredTokens.length) {
  throw new Error(
    `Unsupported token literal: extracted ${declarations.length} of ${declaredTokens.length} Uji tokens`,
  );
}

const generated = `/* Generated from platform-tokens.stylex.ts. Run pnpm --filter @uji-ai/ui sync:tokens. */\n:root {\n  color-scheme: light dark;\n${declarations.join("\n")}\n}\n`;

if (check) {
  const current = await readFile(outputPath, "utf8");
  if (current !== generated) {
    throw new Error("platform-tokens.css is stale; run pnpm --filter @uji-ai/ui sync:tokens");
  }
} else {
  await writeFile(outputPath, generated);
}
