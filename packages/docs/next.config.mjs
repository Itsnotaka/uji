import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  // Memoises components and hooks at build time so marketing pages stop
  // re-rendering on unrelated state changes without hand-written useMemo.
  reactCompiler: true,

  // Everything dynamic must sit behind an explicit `use cache` or a Suspense
  // boundary. On a docs site that is nearly the whole tree, so pages are
  // prerendered and served from cache rather than re-rendered per request.
  cacheComponents: true,

  experimental: {
    // Barrel-file tree-shaking keeps Lucide out of the shared chunk.
    optimizePackageImports: ["lucide-react"],
  },
};

export default withMDX(config);
