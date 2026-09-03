import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: [
    "**/*.md",
    "**/platform-tokens.css",
    "**/routeTree.gen.ts",
    "packages/ai/src/providers/data/**",
    "packages/ai/src/providers/snapshots/**",
  ],
});
