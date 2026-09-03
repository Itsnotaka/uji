import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["react", "eslint", "typescript", "unicorn", "import"],
  categories: {
    correctness: "error",
  },
  options: {
    typeAware: true,
  },
  ignorePatterns: [".claude/**", ".codex/**", ".cursor/**", "**/.otui-probe/**"],
  overrides: [
    {
      files: [
        "packages/ai/src/api/**",
        "packages/ai/src/models.ts",
        "packages/ai/src/models-store.ts",
        "packages/ai/src/utils/**",
        "packages/ai/src/auth/**",
        "packages/ai/scripts/**",
        "packages/ai/src/env-api-keys.ts",
        "packages/ai/src/session-resources.ts",
        "packages/ai/test/upstream/**",
      ],
      rules: {
        "typescript/no-floating-promises": "off",
        "eslint/no-constant-binary-expression": "off",
        "unicorn/no-useless-fallback-in-spread": "off",
        "eslint/no-unused-vars": "off",
        "eslint/no-useless-escape": "off",
        "typescript/restrict-template-expressions": "off",
        "typescript/no-redundant-type-constituents": "off",
        "typescript/no-explicit-any": "off",
        "typescript/unbound-method": "off",
        "typescript/require-array-sort-compare": "off",
        "typescript/no-base-to-string": "off",
        "eslint/complexity": "off",
      },
    },
    {
      // node:test's test() returns a promise the runner already tracks.
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "typescript/no-floating-promises": "off",
      },
    },
    {
      files: ["packages/schema/src/model.ts", "packages/schema/src/message.ts"],
      rules: {
        "typescript/no-redundant-type-constituents": "off",
      },
    },
    {
      files: ["packages/desktop/src/renderer/**/*.{ts,tsx}"],
      rules: {
        "eslint/no-restricted-imports": [
          "error",
          {
            paths: [
              {
                name: "@uji-ai/core",
                allowTypeImports: true,
                message: "Renderer value imports use the browser-safe @uji-ai/core/views entry.",
              },
            ],
            patterns: [
              {
                group: ["@uji-ai/core/*", "!@uji-ai/core/views"],
                allowTypeImports: true,
                message: "Renderer value imports use the browser-safe @uji-ai/core/views entry.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/core/src/plugins/builtin/**"],
      rules: {
        "eslint/no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/harness/**", "../../harness/*"],
                message:
                  "Built-in plugins use SessionApi only. If the API is missing something, add a primitive.",
              },
            ],
          },
        ],
      },
    },
  ],
});
