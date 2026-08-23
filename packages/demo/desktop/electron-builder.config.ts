import type { Configuration } from "electron-builder";

export default {
  appId: "dev.uji.bot",
  productName: "Uji",
  directories: { output: "dist" },
  files: ["out/**/*", "package.json"],
  mac: { category: "public.app-category.productivity" },
} satisfies Configuration;
