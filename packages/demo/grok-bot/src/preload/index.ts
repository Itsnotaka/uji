import { contextBridge, ipcRenderer } from "electron";
import type { JuneDesktopApi, JuneDesktopEvent } from "../desktop-api";

// TODO(protocol): Validate SDK requests, responses, and events at the IPC boundary instead of
// trusting ipcRenderer.invoke results.
const api: JuneDesktopApi = {
  initialize: () => ipcRenderer.invoke("june:initialize"),
  login: () => ipcRenderer.invoke("june:login"),
  send: (message) => ipcRenderer.invoke("june:send", message),
  abort: () => ipcRenderer.invoke("june:abort"),
  newChat: (agentId) => ipcRenderer.invoke("june:new-chat", agentId),
  selectAgent: (agentId) => ipcRenderer.invoke("june:select-agent", agentId),
  createAgent: (draft) => ipcRenderer.invoke("june:create-agent", draft),
  updateAgent: (agentId, changes) => ipcRenderer.invoke("june:update-agent", agentId, changes),
  deleteAgent: (agentId) => ipcRenderer.invoke("june:delete-agent", agentId),
  onEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: JuneDesktopEvent): void => {
      listener(payload);
    };
    ipcRenderer.on("june:event", wrapped);
    return () => ipcRenderer.removeListener("june:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("june", api);
