import type { QueryClient } from "@tanstack/react-query";

import type { JuneSnapshot } from "./desktop-api";

/** The renderer's single server-state view: the host snapshot plus in-flight stream text. */
export type JuneView = JuneSnapshot & {
  streamingText: string;
  notice?: string;
};

export const juneViewKey = ["june", "view"];

export function toView(snapshot: JuneSnapshot): JuneView {
  return { ...snapshot, streamingText: "" };
}

export function updateView(client: QueryClient, update: (view: JuneView) => JuneView): void {
  client.setQueryData(juneViewKey, (current: JuneView | undefined) =>
    current === undefined ? current : update(current),
  );
}

export function setNotice(client: QueryClient, notice: string | undefined): void {
  updateView(client, (view) => ({ ...view, notice }));
}

export function applySnapshot(client: QueryClient, snapshot: JuneSnapshot): void {
  client.setQueryData(juneViewKey, (current: JuneView | undefined): JuneView => {
    const next = toView(snapshot);
    if (!snapshot.auth.signedIn && current?.notice !== undefined) {
      return { ...next, notice: current.notice };
    }
    return next;
  });
}

/** Call once at startup, outside React: routes host-pushed events into the view cache. */
export function registerJuneEvents(client: QueryClient): () => void {
  return window.june.onEvent((event) => {
    switch (event.type) {
      case "delta":
        updateView(client, (view) => ({
          ...view,
          running: true,
          streamingText: view.streamingText + event.text,
        }));
        return;
      case "running":
        updateView(client, (view) => ({
          ...view,
          running: event.running,
          streamingText: event.running ? "" : view.streamingText,
        }));
        return;
      case "status":
      case "error":
        setNotice(client, event.message);
        return;
      case "snapshot":
        applySnapshot(client, event.snapshot);
        return;
    }
  });
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}
