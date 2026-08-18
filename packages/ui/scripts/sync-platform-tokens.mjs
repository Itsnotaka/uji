import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "src/platform-tokens.stylex.ts");
const outputPath = join(packageRoot, "src/platform-tokens.css");
const check = process.argv.includes("--check");

const sourceText = await readFile(sourcePath, "utf8");
const declarations = [];
const tokenPattern = /"(--june-[^"]+)"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?),/g;

for (const match of sourceText.matchAll(tokenPattern)) {
  const [, name, encodedValue] = match;
  const value = encodedValue.startsWith('"') ? JSON.parse(encodedValue) : encodedValue;
  declarations.push(`  ${name}: ${value};`);
}

if (declarations.length === 0) throw new Error("No literal June tokens found");

const generated = `/* Generated from platform-tokens.stylex.ts. Run pnpm --filter @june/ui sync:tokens. */\n:root {\n  color-scheme: light dark;\n${declarations.join("\n")}\n}\n`;

if (check) {
  const current = await readFile(outputPath, "utf8");
  if (current !== generated) {
    throw new Error("platform-tokens.css is stale; run pnpm --filter @june/ui sync:tokens");
  }
} else {
  await writeFile(outputPath, generated);
}
