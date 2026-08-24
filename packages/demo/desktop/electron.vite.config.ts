import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

const esbuild = { tsconfigRaw: { compilerOptions: { target: "ES2024" } } };

export default defineConfig({
  main: {
    esbuild,
    build: {
      externalizeDeps: { exclude: ["@uji-ai/ai", "@uji-ai/core", "@uji-ai/schema"] },
      minify: true,
      reportCompressedSize: false,
      target: "node24",
      rollupOptions: {
        input: resolve("src/main/index.ts"),
        output: { chunkFileNames: "chunks/[name]-[hash].js" },
      },
    },
  },
  preload: {
    esbuild,
    build: {
      minify: true,
      reportCompressedSize: false,
      target: "node24",
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: ".",
    esbuild,
    plugins: [
      stylex.vite({
        useCSSLayers: true,
        lightningcssOptions: { targets: { chrome: 142 << 16 } },
      }),
      react({ babel: { plugins: ["babel-plugin-react-compiler"] } }),
    ],
    optimizeDeps: { exclude: ["@uji-ai/ui"], include: ["react", "react-dom/client"] },
    resolve: { dedupe: ["react", "react-dom"] },
    build: {
      minify: true,
      modulePreload: false,
      reportCompressedSize: false,
      target: "chrome142",
      rollupOptions: { input: resolve("index.html") },
    },
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
  },
});
