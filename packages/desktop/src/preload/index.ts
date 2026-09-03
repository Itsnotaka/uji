/**
 * `window.uji`: the SDK interfaces verbatim (design record, "What each client
 * deletes" — desktop). Every verb is one `invoke` carrying its path and input
 * object; `watch` is the one transport adaptation, an AsyncIterable become a
 * push subscription with the same cursor semantics.
 *
 * Main owns request decoding and reply construction. Preload preserves each
 * path's input/output relationship instead of widening transport payloads.
 */
import type { SessionEvent } from "@uji-ai/core";
import { contextBridge, ipcRenderer } from "electron";
import {
  CALL_CHANNEL,
  HOST_EVENT_CHANNEL,
  WATCH_EVENT_CHANNEL,
  WATCH_START_CHANNEL,
  WATCH_STOP_CHANNEL,
} from "../shared/ipc.ts";
import type {
  CallInput,
  CallOutput,
  CallPath,
  CallReplyFor,
  HostEvent,
  UjiBridge,
  WatchEnvelope,
  WatchInput,
  WatchStartInput,
} from "../shared/ipc.ts";

async function call<P extends CallPath>(path: P, input: CallInput<P>): Promise<CallOutput<P>> {
  // SAFETY: only Uji's main process handles CALL_CHANNEL; it decodes the path-specific
  // request and echoes that path in the matching CallReplyFor<P> envelope.
  const result = (await ipcRenderer.invoke(CALL_CHANNEL, { path, input })) as CallReplyFor<P>;
  if (result.path !== path) throw new Error("Malformed reply from the host: path mismatch");
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

function verb<P extends CallPath>(path: P): (input: CallInput<P>) => Promise<CallOutput<P>> {
  return (input) => call(path, input);
}

const bridge = {
  sessions: {
    create: (input) => call("sessions.create", input),
    get: verb("sessions.get"),
    snapshot: verb("sessions.snapshot"),
    list: (input) => call("sessions.list", input),
    rename: verb("sessions.rename"),
    delete: verb("sessions.delete"),
    configure: verb("sessions.configure"),
  },
  messages: {
    send: verb("messages.send"),
    cancel: verb("messages.cancel"),
    redeliver: verb("messages.redeliver"),
  },
  runs: {
    abort: verb("runs.abort"),
    changes: verb("runs.changes"),
  },
  workspace: {
    list: () => call("workspace.list", undefined),
    forget: verb("workspace.forget"),
    vcs: {
      diff: (input) => call("workspace.vcs.diff", input),
    },
  },
  provider: {
    models: {
      default: () => call("provider.models.default", undefined),
    },
  },
  plugins: {
    list: verb("plugins.list"),
    settings: {
      list: verb("plugins.settings.list"),
      apply: verb("plugins.settings.apply"),
    },
    resources: { list: verb("plugins.resources.list") },
  },
  watch(
    input: WatchInput,
    onEvent: (event: SessionEvent) => void,
    onError?: (error: Error) => void,
  ) {
    const watchId = crypto.randomUUID();
    let ended = false;
    const fail = (message: string): void => {
      if (ended) return;
      ended = true;
      onError?.(new Error(message));
    };
    // WATCH_EVENT_CHANNEL is private to Uji main and emits only WatchEnvelope.
    const listener = (_event: Electron.IpcRendererEvent, frame: WatchEnvelope): void => {
      if (frame.watchId !== watchId || ended) return;
      if (frame.kind === "event") {
        onEvent(frame.event);
        return;
      }
      if (frame.error !== undefined) fail(frame.error);
      else fail("Watch ended unexpectedly");
    };
    ipcRenderer.on(WATCH_EVENT_CHANNEL, listener);
    const start: WatchStartInput =
      "live" in input
        ? { watchId, sessionId: input.sessionId, live: true }
        : { watchId, sessionId: input.sessionId, afterSeq: input.afterSeq };
    // A refused start (bad cursor, no workspace) is a watch that ended before it began.
    const started = ipcRenderer.invoke(WATCH_START_CHANNEL, start).catch((error) => {
      fail(error instanceof Error ? error.message : String(error));
    });
    return () => {
      ended = true;
      ipcRenderer.removeListener(WATCH_EVENT_CHANNEL, listener);
      // START and STOP use separate invoke channels. Preserve their order so a
      // fast unmount cannot stop first and leave the later start orphaned.
      void started
        .then(() => ipcRenderer.invoke(WATCH_STOP_CHANNEL, { watchId }))
        .catch(() => undefined);
    };
  },
  host: {
    state: () => call("host.state", undefined),
    openWorkspace: verb("host.openWorkspace"),
    pickWorkspace: () => call("host.pickWorkspace", undefined),
    trustWorkspace: verb("host.trustWorkspace"),
    closeWorkspace: () => call("host.closeWorkspace", undefined),
    providers: () => call("host.providers", undefined),
    login: verb("host.login"),
    logout: verb("host.logout"),
    models: () => call("host.models", undefined),
    vcs: { snapshot: () => call("host.vcs.snapshot", undefined) },
    github: {
      state: () => call("host.github.state", undefined),
      refresh: () => call("host.github.refresh", undefined),
      signIn: () => call("host.github.signIn", undefined),
      signOut: () => call("host.github.signOut", undefined),
    },
    openExternal: verb("host.openExternal"),
    onEvent(listener: (event: HostEvent) => void) {
      // HOST_EVENT_CHANNEL is private to Uji main and emits only HostEvent.
      const wrapped = (_event: Electron.IpcRendererEvent, event: HostEvent): void => {
        listener(event);
      };
      ipcRenderer.on(HOST_EVENT_CHANNEL, wrapped);
      return () => {
        ipcRenderer.removeListener(HOST_EVENT_CHANNEL, wrapped);
      };
    },
  },
} satisfies UjiBridge;

contextBridge.exposeInMainWorld("uji", bridge);
window.addEventListener(
  "DOMContentLoaded",
  () => {
    document.documentElement.dataset["platform"] = process.platform;
  },
  { once: true },
);
