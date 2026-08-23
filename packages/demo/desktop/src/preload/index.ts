import { contextBridge, ipcRenderer } from "electron";

import type { UjiDesktopApi, UjiDesktopEvent } from "../desktop-api.ts";
import { startBootProfiler } from "./boot-profiler.ts";

const api: UjiDesktopApi = {
  initialize: () => ipcRenderer.invoke("uji:initialize"),
  login: () => ipcRenderer.invoke("uji:login"),
  send: (message) => ipcRenderer.invoke("uji:send", message),
  abort: () => ipcRenderer.invoke("uji:abort"),
  newChat: (agentId) => ipcRenderer.invoke("uji:new-chat", agentId),
  selectAgent: (agentId) => ipcRenderer.invoke("uji:select-agent", agentId),
  onEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: UjiDesktopEvent): void => {
      listener(payload);
    };
    ipcRenderer.on("uji:event", wrapped);
    return () => ipcRenderer.removeListener("uji:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("uji", api);
window.addEventListener(
  "DOMContentLoaded",
  () => {
    document.documentElement.dataset["platform"] = process.platform;
  },
  { once: true },
);
startBootProfiler();
