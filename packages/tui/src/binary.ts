import { anthropicOAuth, openaiCodexOAuth, registerBundledOAuthFlowLoaders } from "@uji-ai/ai";

// The normal loaders use bundler-opaque dynamic imports to keep Node-only OAuth
// code out of browser builds. A standalone Bun executable has no source files
// to load at runtime, so make those modules static dependencies of this entry.
registerBundledOAuthFlowLoaders({
  anthropic: () => anthropicOAuth,
  openaiCodex: () => openaiCodexOAuth,
});

await import("./index.ts");
