/** Browser-safe binding for core's client-view graph inside Electron's renderer. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
