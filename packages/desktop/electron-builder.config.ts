import type { Configuration } from "electron-builder";

export default {
  appId: "ai.uji.desktop",
  productName: "Uji",
  directories: { output: "dist", buildResources: "build" },
  files: ["out/**/*", "package.json"],
  mac: { category: "public.app-category.developer-tools" },
  linux: { target: ["AppImage"], category: "Development" },
} satisfies Configuration;
