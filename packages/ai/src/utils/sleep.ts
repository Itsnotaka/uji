/**
 * Abortable sleep.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/src/utils/sleep.ts
 * Synced with pi 7ebf9087e.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
