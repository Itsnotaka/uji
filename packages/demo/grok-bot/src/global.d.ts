import type { JuneDesktopApi } from "./desktop-api";

declare global {
  interface Window {
    june: JuneDesktopApi;
  }
}

export {};
