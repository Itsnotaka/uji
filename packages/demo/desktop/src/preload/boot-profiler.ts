import { ipcRenderer } from "electron";

/** Based on https://github.com/lobehub/lobehub/blob/main/apps/desktop/src/preload/bootProfiler.ts */
export function startBootProfiler(): void {
  if (process.env["UJI_DESKTOP_BOOT_PROFILE"] !== "1") return;

  window.addEventListener(
    "DOMContentLoaded",
    () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const navigation = performance.getEntriesByType("navigation")[0];
          const domContentLoadedMs =
            navigation instanceof PerformanceNavigationTiming
              ? navigation.domContentLoadedEventEnd
              : 0;
          ipcRenderer.send("uji:boot-profile", {
            navigationStartedAt: performance.timeOrigin,
            domContentLoadedMs,
            firstVisibleFrameMs: performance.now(),
          });
        });
      });
    },
    { once: true },
  );
}
