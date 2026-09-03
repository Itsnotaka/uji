import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { isAbsolute, join } from "node:path";
import type { ModelThinkingLevel } from "@uji-ai/ai";
import { sessionId as parseSessionId } from "@uji-ai/core";

import { parseAgentDraft } from "../agents.ts";
import type { RuntimeSettingsChange, UjiDesktopEvent } from "../desktop-api.ts";
import type { UjiHost } from "./uji-host.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const mainProcessStartedAt = Date.now() - process.uptime() * 1_000;
let mainWindow: BrowserWindow | undefined;
let hostPromise: Promise<UjiHost> | undefined;
let hostActions: Promise<void> = Promise.resolve();

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
        createProductionDependencies(
          (url) => shell.openExternal(url),
          join(app.getPath("userData"), "auth.json"),
        ),
      ),
  );
  return hostPromise;
}

function withHost<TResult>(run: (host: UjiHost) => Promise<TResult>): Promise<TResult> {
  const result = hostActions.then(getHost).then(run);
  hostActions = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function registerIpc(): void {
  ipcMain.handle("uji:initialize", () => withHost((host) => host.initialize()));
  ipcMain.handle("uji:login", () => withHost((host) => host.login()));
  ipcMain.handle("uji:logout", () => withHost((host) => host.logout()));
  ipcMain.handle("uji:send", (_event, message: unknown) => {
    if (typeof message !== "string" || message.trim() === "") throw new Error("Message is empty");
    return withHost((host) => host.send(message.trim()));
  });
  ipcMain.handle("uji:cancel-queued", (_event, entryId: unknown) => {
    if (typeof entryId !== "string" || entryId === "") {
      throw new Error("Queued message id is required");
    }
    return withHost((host) => host.cancelQueued(entryId));
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
  ipcMain.handle("uji:select-conversation", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("Conversation id is required");
    }
    return withHost((host) => host.selectConversation(parseSessionId(sessionId)));
  });
  ipcMain.handle("uji:rename-conversation", (_event, sessionId: unknown, name: unknown) => {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("Conversation id is required");
    }
    if (typeof name !== "string") throw new Error("Conversation title is required");
    return withHost((host) => host.renameConversation(parseSessionId(sessionId), name));
  });
  ipcMain.handle("uji:create-agent", (_event, draft: unknown) =>
    withHost((host) => host.createAgent(parseAgentDraft(draft))),
  );
  ipcMain.handle("uji:update-agent", (_event, agentId: unknown, draft: unknown) => {
    if (typeof agentId !== "string" || agentId === "") throw new Error("Agent id is required");
    return withHost((host) => host.updateAgent(agentId, parseAgentDraft(draft)));
  });
  ipcMain.handle("uji:delete-agent", (_event, agentId: unknown) => {
    if (typeof agentId !== "string" || agentId === "") throw new Error("Agent id is required");
    return withHost((host) => host.deleteAgent(agentId));
  });
  ipcMain.handle("uji:update-runtime-settings", (_event, change: unknown) =>
    withHost((host) => host.updateRuntimeSettings(parseRuntimeSettingsChange(change))),
  );
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
    width: 1040,
    height: 760,
    minWidth: 512,
    minHeight: 520,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#070707" : "#fcfcfc",
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

function parseRuntimeSettingsChange(value: unknown): RuntimeSettingsChange {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("Runtime setting is missing");
  }
  if (value.kind === "model") {
    const modelKey = "modelKey" in value ? value.modelKey : undefined;
    if (typeof modelKey !== "string" || modelKey === "") throw new Error("Model is required");
    return { kind: "model", modelKey };
  }
  if (value.kind === "thinking") {
    const thinkingLevel = "thinkingLevel" in value ? value.thinkingLevel : undefined;
    if (!isThinkingLevel(thinkingLevel)) {
      throw new Error("Reasoning level is invalid");
    }
    return { kind: "thinking", thinkingLevel };
  }
  throw new Error("Runtime setting is invalid");
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
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
    const host = hostPromise;
    if (host !== undefined) {
      const closing = hostActions.then(() => host).then((opened) => opened.close());
      hostActions = closing.catch(() => undefined);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
