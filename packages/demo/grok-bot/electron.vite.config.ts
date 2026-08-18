import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@june/ai", "@june/core", "@june/schema"] },
      target: "node24",
      rollupOptions: { input: resolve("src/main/index.ts") },
    },
  },
  preload: {
    build: {
      target: "node24",
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [
      stylex.vite({
        useCSSLayers: true,
        lightningcssOptions: { targets: { chrome: 123 << 16 } },
      }),
      react(),
      tailwindcss(),
    ],
    optimizeDeps: { exclude: ["@june/ui"] },
    resolve: {
      alias: { "@": resolve("src") },
      dedupe: ["react", "react-dom"],
    },
    build: { target: "chrome142", rollupOptions: { input: resolve("index.html") } },
    server: { port: 5173, strictPort: true },
  },
});
