import type { SessionId } from "@uji-ai/core";
import type { PaneId, SplitDirection } from "./pane-layout.ts";

export interface ComposerViewState {
  readonly draft: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly focused: boolean;
}

export interface ScrollViewState {
  readonly top: number;
  readonly bottomPinned: boolean;
}

export interface SplitViewState {
  readonly direction: SplitDirection;
  readonly ratio: number;
}

export interface SessionViewState {
  readonly composer: ComposerViewState;
  readonly scroll: ScrollViewState;
  readonly focusedPaneId: PaneId;
  readonly split: SplitViewState | undefined;
}

export interface BlankViewState {
  readonly composer: ComposerViewState;
}

export const DEFAULT_COMPOSER_VIEW_STATE: ComposerViewState = {
  draft: "",
  selectionStart: 0,
  selectionEnd: 0,
  focused: false,
};

function defaultSessionViewState(paneId: PaneId): SessionViewState {
  return {
    composer: DEFAULT_COMPOSER_VIEW_STATE,
    scroll: { top: 0, bottomPinned: true },
    focusedPaneId: paneId,
    split: undefined,
  };
}

export class SessionViewStateStore {
  readonly #sessions = new Map<SessionId, SessionViewState>();
  readonly #blanks = new Map<PaneId, BlankViewState>();

  readSession(sessionId: SessionId, paneId: PaneId): SessionViewState {
    return this.#sessions.get(sessionId) ?? defaultSessionViewState(paneId);
  }

  writeSession(sessionId: SessionId, state: SessionViewState): void {
    this.#sessions.set(sessionId, state);
  }

  updateSession(
    sessionId: SessionId,
    paneId: PaneId,
    update: (current: SessionViewState) => SessionViewState,
  ): SessionViewState {
    const next = update(this.readSession(sessionId, paneId));
    this.writeSession(sessionId, next);
    return next;
  }

  readBlank(paneId: PaneId): BlankViewState {
    return this.#blanks.get(paneId) ?? { composer: DEFAULT_COMPOSER_VIEW_STATE };
  }

  writeBlank(paneId: PaneId, state: BlankViewState): void {
    this.#blanks.set(paneId, state);
  }
}
