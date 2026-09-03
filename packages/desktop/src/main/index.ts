import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import {
  CALL_CHANNEL,
  HOST_EVENT_CHANNEL,
  WATCH_EVENT_CHANNEL,
  WATCH_START_CHANNEL,
  WATCH_STOP_CHANNEL,
} from "../shared/ipc.ts";
import type { HostEvent, WatchEnvelope } from "../shared/ipc.ts";
import { safeExternalUrl } from "./external-url.ts";
import type { DesktopHost, DesktopHostDependencies } from "./host.ts";

let mainWindow: BrowserWindow | undefined;
let hostPromise: Promise<DesktopHost> | undefined;
let ipcInputsPromise: Promise<typeof import("./ipc-inputs.ts")> | undefined;

app.setName("Uji");
app.setPath("userData", join(app.getPath("appData"), app.isPackaged ? "Uji" : "Uji Dev"));
if (process.platform === "linux") app.commandLine.appendSwitch("gtk-version", "3");

function send(channel: string, payload: HostEvent | WatchEnvelope): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const hostDependencies = {
  emitHostEvent: (event) => send(HOST_EVENT_CHANNEL, event),
  emitWatchEvent: (envelope) => send(WATCH_EVENT_CHANNEL, envelope),
  openExternal: (url) => void shell.openExternal(url),
  pickFolder: async () => {
    const window = mainWindow;
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      message: "Open a workspace folder",
    };
    const result =
      window === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    return result.canceled ? undefined : result.filePaths[0];
  },
} satisfies DesktopHostDependencies;

function getHost(): Promise<DesktopHost> {
  hostPromise ??= import("./host.ts").then(({ DesktopHost: Host }) => new Host(hostDependencies));
  return hostPromise;
}

function getIpcInputs(): Promise<typeof import("./ipc-inputs.ts")> {
  ipcInputsPromise ??= import("./ipc-inputs.ts");
  return ipcInputsPromise;
}

function assertMainFrame(event: Electron.IpcMainInvokeEvent): void {
  const window = mainWindow;
  if (
    window === undefined ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("IPC request did not come from the main window");
  }
}

function registerIpc(): void {
  ipcMain.handle(CALL_CHANNEL, async (event, request) => {
    assertMainFrame(event);
    const [{ decodeCallRequest }, host] = await Promise.all([getIpcInputs(), getHost()]);
    const decoded = decodeCallRequest(request);
    try {
      const value = await host.call(decoded.path, decoded.input);
      return { path: decoded.path, ok: true, value };
    } catch (cause) {
      return {
        path: decoded.path,
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });

  ipcMain.handle(WATCH_START_CHANNEL, async (event, input) => {
    assertMainFrame(event);
    const [{ decodeWatchStart }, host] = await Promise.all([getIpcInputs(), getHost()]);
    host.watchStart(decodeWatchStart(input));
  });

  ipcMain.handle(WATCH_STOP_CHANNEL, async (event, input) => {
    assertMainFrame(event);
    const [{ decodeWatchStop }, host] = await Promise.all([getIpcInputs(), getHost()]);
    host.watchStop(decodeWatchStop(input));
  });
}

function createWindow(): void {
  if (mainWindow !== undefined) return;
  const created = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 560,
    minHeight: 480,
    // grok-bot chrome tokens: dark #111111, light #f7f7f7.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f7f7f7",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.js"),
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
    void created.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  else void created.loadURL(developmentUrl);

  created.on("closed", () => {
    if (mainWindow === created) mainWindow = undefined;
  });
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
    void hostPromise?.then(
      (host) => host.close(),
      () => undefined,
    );
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
