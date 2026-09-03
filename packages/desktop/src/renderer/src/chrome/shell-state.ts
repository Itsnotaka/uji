/**
 * Window-lifetime chrome state that more than one surface reads: whether the
 * rail is shown and how wide it is, and which Settings section is open. It
 * lives outside the component tree so the titlebar, the rail, and keyboard
 * chords all steer the same values, and so Settings still opens while the
 * rail is hidden. The rail width is also written to the root as a CSS
 * variable, so the static boot shell and the mounted rail share one number.
 */
import { useSyncExternalStore } from "react";
import type { SessionId } from "@uji-ai/core";

export type SettingsSection = "general" | "appearance" | "accounts" | "customize";

export interface SettingsRequest {
  readonly section: SettingsSection;
  readonly sessionId: SessionId | undefined;
  /** Returned focus target once the dialog closes. */
  readonly trigger: HTMLElement | null;
}

export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_WIDTH_MIN = 210;
export const SIDEBAR_WIDTH_MAX = 400;
export const SIDEBAR_WIDTH_STEP = 8;

const SIDEBAR_KEY = "uji.desktop.sidebar.v2";
const SIDEBAR_WIDTH_VARIABLE = "--uji-sidebar-width";

interface ShellState {
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly settings: SettingsRequest | undefined;
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readPersisted(): Pick<ShellState, "sidebarVisible" | "sidebarWidth"> {
  const fallback = { sidebarVisible: true, sidebarWidth: SIDEBAR_WIDTH_DEFAULT };
  try {
    const raw = storage()?.getItem(SIDEBAR_KEY);
    if (raw === null || raw === undefined) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const visible = "visible" in parsed ? parsed.visible : undefined;
    const width = "width" in parsed ? parsed.width : undefined;
    return {
      sidebarVisible: visible !== false,
      sidebarWidth: typeof width === "number" ? clampSidebarWidth(width) : SIDEBAR_WIDTH_DEFAULT,
    };
  } catch {
    return fallback;
  }
}

function persist(next: ShellState): void {
  try {
    storage()?.setItem(
      SIDEBAR_KEY,
      JSON.stringify({ visible: next.sidebarVisible, width: next.sidebarWidth }),
    );
  } catch {
    // The in-memory choice still applies for this window.
  }
}

function applyWidth(width: number): void {
  document.documentElement.style.setProperty(SIDEBAR_WIDTH_VARIABLE, `${String(width)}px`);
}

let state: ShellState = { ...readPersisted(), settings: undefined };
applyWidth(state.sidebarWidth);
const listeners = new Set<() => void>();

function publish(next: ShellState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ShellState {
  return state;
}

export const shellActions = Object.freeze({
  setSidebarVisible(visible: boolean): void {
    if (state.sidebarVisible === visible) return;
    const next = { ...state, sidebarVisible: visible };
    persist(next);
    publish(next);
  },
  toggleSidebar(): void {
    shellActions.setSidebarVisible(!state.sidebarVisible);
  },
  setSidebarWidth(width: number): void {
    const sidebarWidth = clampSidebarWidth(width);
    if (state.sidebarWidth === sidebarWidth) return;
    const next = { ...state, sidebarWidth };
    applyWidth(sidebarWidth);
    persist(next);
    publish(next);
  },
  openSettings(
    section: SettingsSection = "general",
    options: { readonly sessionId?: SessionId; readonly trigger?: HTMLElement | null } = {},
  ): void {
    publish({
      ...state,
      settings: {
        section,
        sessionId: options.sessionId,
        trigger: options.trigger ?? null,
      },
    });
  },
  closeSettings(): void {
    if (state.settings === undefined) return;
    const { trigger } = state.settings;
    publish({ ...state, settings: undefined });
    if (trigger !== null) window.requestAnimationFrame(() => trigger.focus());
  },
});

export function useShellState(): ShellState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
