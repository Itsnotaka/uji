import type { Configuration } from "electron-builder";

export default {
  appId: "dev.june.bot",
  productName: "June",
  directories: { output: "dist" },
  files: ["out/**/*", "package.json"],
  mac: { category: "public.app-category.productivity" },
} satisfies Configuration;
