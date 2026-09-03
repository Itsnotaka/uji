#!/usr/bin/env node

const VERSION = "0.0.2";
const HELP = `uji

Headless agent runner and terminal client for Uji

Usage:
  uji          Open the terminal client
  uji serve    Run the standalone headless server

Status:
  This package currently reserves the uji command. The runner is not released yet.`;

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${VERSION}\n`);
} else if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`${HELP}\n`);
} else {
  process.stderr.write(
    "Uji is not available yet. This package reserves the uji command for the upcoming headless runner and terminal client.\n",
  );
  process.stderr.write("Run `npx uji-ai --help` to see the planned command shape.\n");
  process.exitCode = 1;
}
