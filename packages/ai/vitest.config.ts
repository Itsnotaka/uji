import { defineConfig } from "vitest/config";

// Upstream pi-ai tests copied verbatim run under vitest; June's own tests use node:test.
// The excluded files import pi's deprecated global registry (src/compat.ts), which June does not carry.
export default defineConfig({
  test: {
    include: ["test/upstream/**/*.test.ts"],
    exclude: [
      "test/upstream/model-catalog-types.test.ts", // imports other providers' catalogs
      "test/upstream/generate-models-strict.test.ts", // runs the full generator, needs every provider catalog

      "test/upstream/anthropic-adaptive-thinking-models.test.ts",
      "test/upstream/anthropic-cache-write-1h-cost.test.ts",
      "test/upstream/anthropic-empty-thinking-signature-compat.test.ts",
      "test/upstream/anthropic-force-adaptive-thinking.test.ts",
      "test/upstream/anthropic-sse-parsing.test.ts",
      "test/upstream/anthropic-temperature-compat.test.ts",
      "test/upstream/anthropic-thinking-disable.test.ts",
      "test/upstream/cache-retention.test.ts",
      "test/upstream/anthropic-tool-name-normalization.test.ts",
      "test/upstream/cross-provider-handoff.test.ts",
      "test/upstream/interleaved-thinking.test.ts",
      "test/upstream/image-tool-result.test.ts",
      "test/upstream/lazy-module-load.test.ts",
      "test/upstream/max-thinking.test.ts",
      "test/upstream/openai-responses-empty-tool-result.test.ts",
      "test/upstream/openai-responses-compat.test.ts",
      "test/upstream/openai-responses-message-id.test.ts",
      "test/upstream/openai-responses-foreign-toolcall-id.test.ts",
      "test/upstream/openai-responses-tool-result-images.test.ts",
      "test/upstream/tool-call-id-normalization.test.ts",
    ],
  },
});
