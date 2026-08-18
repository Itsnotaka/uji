import { contextBridge, ipcRenderer } from "electron";
import type { JuneDesktopApi, JuneDesktopEvent } from "../desktop-api";

// TODO(protocol): Validate SDK requests, responses, and events at the IPC boundary instead of
// asserting ipcRenderer.invoke results with compile-time casts.
const api: JuneDesktopApi = {
  initialize: () => ipcRenderer.invoke("june:initialize") as Promise<ReturnTypeShape>,
  login: () => ipcRenderer.invoke("june:login") as Promise<ReturnTypeShape>,
  send: (message) => ipcRenderer.invoke("june:send", message) as Promise<ReturnTypeShape>,
  abort: () => ipcRenderer.invoke("june:abort") as Promise<void>,
  newChat: (agentId) => ipcRenderer.invoke("june:new-chat", agentId) as Promise<ReturnTypeShape>,
  selectAgent: (agentId) =>
    ipcRenderer.invoke("june:select-agent", agentId) as Promise<ReturnTypeShape>,
  updateAgent: (agentId, changes) =>
    ipcRenderer.invoke("june:update-agent", agentId, changes) as Promise<ReturnTypeShape>,
  onEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: JuneDesktopEvent): void => {
      listener(payload);
    };
    ipcRenderer.on("june:event", wrapped);
    return () => ipcRenderer.removeListener("june:event", wrapped);
  },
};

type ReturnTypeShape = Awaited<ReturnType<JuneDesktopApi["initialize"]>>;

contextBridge.exposeInMainWorld("june", api);
