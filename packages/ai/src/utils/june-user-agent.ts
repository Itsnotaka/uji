/**
 * Builds the User-Agent string June sends on provider requests. OS details are loaded through `process.getBuiltinModule` so the module stays browser-safe.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/utils/june-user-agent.ts
 * Synced with pi 7ebf9087e.
 */
import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.
const nodeOs = loadNodeOs();

export function getJuneUserAgent(): string {
  return nodeOs
    ? `june (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})`
    : "june (browser)";
}
