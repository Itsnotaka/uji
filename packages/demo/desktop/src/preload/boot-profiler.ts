import { ipcRenderer } from "electron";

/**
 * Report renderer boot timings to the main process, which prints them when
 * `UJI_DESKTOP_BOOT_PROFILE=1`.
 *
 * The nested animation frames are what make the last number a paint rather
 * than a layout: the outer frame runs before the first paint, so only the
 * inner one is guaranteed to run after it.
 */
export function startBootProfiler(): void {
  if (process.env["UJI_DESKTOP_BOOT_PROFILE"] !== "1") return;

  const send = (): void => {
    const [navigation] = performance.getEntriesByType("navigation");
    ipcRenderer.send("uji:boot-profile", {
      navigationStartedAt: performance.timeOrigin,
      domContentLoadedMs:
        navigation instanceof PerformanceNavigationTiming ? navigation.domContentLoadedEventEnd : 0,
      firstVisibleFrameMs: performance.now(),
    });
  };

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(send);
      });
    },
    { once: true },
  );
}
