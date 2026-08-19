import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { parseAgentDraft } from "../agents";
import type { JuneDesktopEvent } from "../desktop-api";
import { JuneHost } from "./june-host";
import { createProductionDependencies } from "./production-dependencies";

let window: BrowserWindow | undefined;

app.setName("June");
app.setPath("userData", join(app.getPath("appData"), "June"));
if (process.platform === "darwin") app.commandLine.appendSwitch("use-mock-keychain");

function emit(event: JuneDesktopEvent): void {
  window?.webContents.send("june:event", event);
}

function safeExternalUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  return url.toString();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 512,
    minHeight: 520,
    // Native prepaint cannot consume renderer CSS variables; mirror the background token pair.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#090a0b" : "#fdfdfc",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(safeExternalUrl(url));
    } catch {
      // Invalid renderer URLs stay closed.
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const current = window?.webContents.getURL();
    if (current !== undefined && url !== current) event.preventDefault();
  });

  const developmentUrl = process.env["ELECTRON_RENDERER_URL"];
  if (developmentUrl !== undefined) void window.loadURL(developmentUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));

  window.on("closed", () => {
    window = undefined;
  });
}

void app.whenReady().then(() => {
  const host = new JuneHost(
    join(app.getPath("userData"), "sessions.db"),
    emit,
    createProductionDependencies((url) => shell.openExternal(url)),
  );

  ipcMain.handle("june:initialize", () => host.initialize());
  ipcMain.handle("june:login", () => host.login());
  ipcMain.handle("june:send", (_event, message: unknown) => {
    // TODO(protocol): Parse the canonical sdk.session.prompt request schema at the IPC boundary
    // instead of maintaining a one-off string validator for this demo channel.
    if (typeof message !== "string" || message.trim() === "") throw new Error("Message is empty");
    return host.send(message.trim());
  });
  ipcMain.handle("june:abort", () => host.abort());
  ipcMain.handle("june:new-chat", (_event, agentId: unknown) => {
    if (agentId !== undefined && typeof agentId !== "string") {
      throw new Error("Agent id must be a string");
    }
    return host.newChat(agentId);
  });
  ipcMain.handle("june:select-agent", (_event, agentId: unknown) => {
    if (typeof agentId !== "string") throw new Error("Agent id is required");
    return host.selectAgent(agentId);
  });
  ipcMain.handle("june:create-agent", (_event, draft: unknown) =>
    host.createAgent(parseAgentDraft(draft)),
  );
  ipcMain.handle("june:update-agent", (_event, agentId: unknown, changes: unknown) => {
    if (typeof agentId !== "string") throw new Error("Agent id is required");
    return host.updateAgent(agentId, parseAgentDraft(changes));
  });
  ipcMain.handle("june:delete-agent", (_event, agentId: unknown) => {
    if (typeof agentId !== "string") throw new Error("Agent id is required");
    return host.deleteAgent(agentId);
  });
  createWindow();

  app.on("before-quit", () => {
    void host.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
