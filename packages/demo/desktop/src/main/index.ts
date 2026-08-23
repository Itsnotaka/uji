import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { isAbsolute, join } from "node:path";

import type { UjiDesktopEvent } from "../desktop-api.ts";
import type { UjiHost } from "./uji-host.ts";

const mainProcessStartedAt = Date.now() - process.uptime() * 1_000;
let mainWindow: BrowserWindow | undefined;
let hostPromise: Promise<UjiHost> | undefined;

app.setName("Uji");
const userDataOverride = process.env["UJI_DESKTOP_USER_DATA_DIR"];
if (userDataOverride !== undefined && !isAbsolute(userDataOverride)) {
  throw new Error("UJI_DESKTOP_USER_DATA_DIR must be an absolute path");
}
app.setPath(
  "userData",
  userDataOverride ?? join(app.getPath("appData"), app.isPackaged ? "Uji" : "Uji Dev"),
);
if (process.platform === "linux") app.commandLine.appendSwitch("gtk-version", "3");

function emit(event: UjiDesktopEvent): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("uji:event", event);
  }
}

function safeExternalUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  return url.toString();
}

function getHost(): Promise<UjiHost> {
  hostPromise ??= Promise.all([
    import("./uji-host.ts"),
    import("./production-dependencies.ts"),
  ]).then(
    ([{ UjiHost: Host }, { createProductionDependencies }]) =>
      new Host(
        join(app.getPath("userData"), "sessions.db"),
        emit,
        createProductionDependencies((url) => shell.openExternal(url)),
      ),
  );
  return hostPromise;
}

function withHost<TResult>(run: (host: UjiHost) => Promise<TResult>): Promise<TResult> {
  return getHost().then(run);
}

function registerIpc(): void {
  ipcMain.handle("uji:initialize", () => withHost((host) => host.initialize()));
  ipcMain.handle("uji:login", () => withHost((host) => host.login()));
  ipcMain.handle("uji:send", (_event, message: unknown) => {
    if (typeof message !== "string" || message.trim() === "") throw new Error("Message is empty");
    return withHost((host) => host.send(message.trim()));
  });
  ipcMain.handle("uji:abort", () => withHost((host) => host.abort()));
  ipcMain.handle("uji:new-chat", (_event, agentId: unknown) => {
    if (agentId !== undefined && typeof agentId !== "string") {
      throw new Error("Agent id must be a string");
    }
    return withHost((host) => host.newChat(agentId));
  });
  ipcMain.handle("uji:select-agent", (_event, agentId: unknown) => {
    if (typeof agentId !== "string") throw new Error("Agent id is required");
    return withHost((host) => host.selectAgent(agentId));
  });
  ipcMain.on("uji:boot-profile", (_event, payload: unknown) => {
    if (process.env["UJI_DESKTOP_BOOT_PROFILE"] !== "1" || !isBootProfile(payload)) return;
    const processToNavigationMs = payload.navigationStartedAt - mainProcessStartedAt;
    const profile = {
      processToNavigationMs,
      navigationToDomContentLoadedMs: payload.domContentLoadedMs,
      domContentLoadedToVisibleFrameMs: payload.firstVisibleFrameMs - payload.domContentLoadedMs,
      totalMs: processToNavigationMs + payload.firstVisibleFrameMs,
    };
    process.stdout.write(`__UJI_DESKTOP_BOOT_PROFILE__${JSON.stringify(profile)}\n`);
  });
}

function createWindow(): void {
  if (mainWindow !== undefined) return;
  const created = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#101110" : "#fbfbfa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = created;

  created.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(safeExternalUrl(url));
    } catch {
      // Invalid renderer URLs stay closed.
    }
    return { action: "deny" };
  });
  created.webContents.on("will-attach-webview", (event) => event.preventDefault());
  created.webContents.on("will-navigate", (event, url) => {
    if (url !== created.webContents.getURL()) event.preventDefault();
  });

  const developmentUrl = process.env["ELECTRON_RENDERER_URL"];
  if (developmentUrl === undefined)
    void created.loadFile(join(__dirname, "../renderer/index.html"));
  else void created.loadURL(developmentUrl);

  created.on("closed", () => {
    if (mainWindow === created) mainWindow = undefined;
  });
}

function isBootProfile(value: unknown): value is {
  navigationStartedAt: number;
  domContentLoadedMs: number;
  firstVisibleFrameMs: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const values = [
    "navigationStartedAt" in value ? value.navigationStartedAt : undefined,
    "domContentLoadedMs" in value ? value.domContentLoadedMs : undefined,
    "firstVisibleFrameMs" in value ? value.firstVisibleFrameMs : undefined,
  ];
  return values.every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  registerIpc();

  app.on("second-instance", () => {
    if (mainWindow?.isMinimized() === true) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  void app.whenReady().then(createWindow);

  app.on("before-quit", () => {
    void hostPromise?.then((host) => host.close());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
