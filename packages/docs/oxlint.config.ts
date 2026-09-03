import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "react", "import", "nextjs"],
  categories: {},
  env: {
    builtin: true,
  },
  settings: {
    react: {
      version: "19.2.8",
    },
    tailwindcss: {
      callees: ["clsx", "cva", "cn"],
    },
  },
  ignorePatterns: ["node_modules/", "dist/"],
});
