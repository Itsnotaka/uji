import type { UjiDesktopApi } from "./desktop-api";

declare global {
  interface Window {
    uji: UjiDesktopApi;
  }
}

export {};
