import type { StreamFn } from "./types.ts";

let defaultStreamFn: StreamFn | undefined;

/**
 * Configure the fallback used by low-level loops when callers omit `streamFn`.
 * Hosts can install their model runtime without coupling core to a provider catalog.
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
  defaultStreamFn = streamFn;
}

export function getDefaultStreamFn(): StreamFn {
  if (!defaultStreamFn) {
    throw new Error(
      "No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().",
    );
  }
  return defaultStreamFn;
}
