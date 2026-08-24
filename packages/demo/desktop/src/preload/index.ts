import { contextBridge, ipcRenderer } from "electron";

import type { UjiDesktopApi, UjiDesktopEvent } from "../desktop-api.ts";
import { startBootProfiler } from "./boot-profiler.ts";

const api: UjiDesktopApi = {
  initialize: () => ipcRenderer.invoke("uji:initialize"),
  login: () => ipcRenderer.invoke("uji:login"),
  logout: () => ipcRenderer.invoke("uji:logout"),
  send: (message) => ipcRenderer.invoke("uji:send", message),
  cancelQueued: (entryId) => ipcRenderer.invoke("uji:cancel-queued", entryId),
  abort: () => ipcRenderer.invoke("uji:abort"),
  newChat: (agentId) => ipcRenderer.invoke("uji:new-chat", agentId),
  selectAgent: (agentId) => ipcRenderer.invoke("uji:select-agent", agentId),
  selectConversation: (sessionId) => ipcRenderer.invoke("uji:select-conversation", sessionId),
  renameConversation: (sessionId, name) =>
    ipcRenderer.invoke("uji:rename-conversation", sessionId, name),
  createAgent: (draft) => ipcRenderer.invoke("uji:create-agent", draft),
  updateAgent: (agentId, draft) => ipcRenderer.invoke("uji:update-agent", agentId, draft),
  deleteAgent: (agentId) => ipcRenderer.invoke("uji:delete-agent", agentId),
  updateRuntimeSettings: (change) => ipcRenderer.invoke("uji:update-runtime-settings", change),
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
