import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIB = 1_024;
// The renderer entry carries React, the router, StyleX output, and Base UI's
// menu and dialog machinery; everything heavier (diffs, highlighting) is lazy.
const budgets = {
  main: 32 * KIB,
  preload: 16 * KIB,
  rendererEntry: 1_300 * KIB,
};
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rendererRoot = join(desktopRoot, "out", "renderer");
const html = await readFile(join(rendererRoot, "index.html"), "utf8");
const rendererEntry = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
if (rendererEntry === undefined) throw new Error("Cannot find the renderer entry in index.html");

const sizes = {
  main: (await stat(join(desktopRoot, "out", "main", "index.js"))).size,
  preload: (await stat(join(desktopRoot, "out", "preload", "index.js"))).size,
  rendererEntry: (await stat(join(rendererRoot, rendererEntry))).size,
};

for (const name of Object.keys(budgets)) {
  if (sizes[name] > budgets[name]) {
    throw new Error(
      `${name} startup entry is ${formatSize(sizes[name])}; budget is ${formatSize(budgets[name])}`,
    );
  }
}

process.stdout.write(
  `startup entries: main ${formatSize(sizes.main)}, preload ${formatSize(sizes.preload)}, renderer ${formatSize(sizes.rendererEntry)}\n`,
);

function formatSize(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}
