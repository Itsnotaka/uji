import type { KeyEvent } from "@opentui/core";
import type { ThinkingLevel } from "@uji-ai/core";

export type TuiKeyAction = "clear_for_quit" | "shutdown";

/** How long a second escape still counts as part of the same gesture. */
export const DOUBLE_ESCAPE_MS = 500;

/**
 * Escape twice on an empty composer takes back the last message you sent.
 * The first press only arms the pair, so a lone escape keeps meaning "stop".
 *
 * Based on pi's double-escape timer:
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2866
 */
export class DoubleEscape {
  private armedAt = 0;

  /** True when this press closes the pair; the next press starts a new one. */
  press(now: number = Date.now()): boolean {
    const paired = now - this.armedAt < DOUBLE_ESCAPE_MS;
    this.armedAt = paired ? 0 : now;
    return paired;
  }
}

export interface TuiKeyState {
  selecting: boolean;
  inputMode: "chat" | "auth";
  authenticating: boolean;
  hasDraft: boolean;
}

export interface TuiFocusTarget {
  focus: () => void;
  blur: () => void;
}

/** Keeps the active editor stable across terminal and pane focus changes. */
export class TuiFocusController {
  private readonly defaultTarget: TuiFocusTarget;
  private target: TuiFocusTarget;
  private terminalFocused = true;

  constructor(defaultTarget: TuiFocusTarget) {
    this.defaultTarget = defaultTarget;
    this.target = defaultTarget;
  }

  use(target: TuiFocusTarget): void {
    this.target = target;
    if (this.terminalFocused) target.focus();
    else target.blur();
  }

  reset(): void {
    this.use(this.defaultTarget);
  }

  isUsing(target: TuiFocusTarget): boolean {
    return this.target === target;
  }

  blur(): void {
    if (!this.terminalFocused) return;
    this.terminalFocused = false;
    this.target.blur();
  }

  restore(): void {
    this.terminalFocused = true;
    this.target.focus();
  }
}

export function nextThinkingLevel(
  current: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
  if (supported.length < 2) return undefined;
  const currentIndex = supported.indexOf(current);
  return supported[(currentIndex + 1) % supported.length];
}

/** A printable key that can be forwarded from scrollback into the composer. */
export function isComposerTextKey(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option === true || key.super === true) return false;
  const first = key.sequence.charCodeAt(0);
  return key.sequence !== "" && first >= 32 && first !== 127;
}

/** The one thing escape can mean right now. */
export type EscapeIntent = "abort" | "focus_composer" | "edit_last_message" | "ignore";

export interface EscapeState extends TuiKeyState {
  /** A run or a compaction is in flight, so there is work to interrupt. */
  busy: boolean;
  scrollbackFocused: boolean;
}

/**
 * Escape resolves in one place instead of in whichever handler sees the key
 * first, so stopping the agent never depends on which pane holds focus. That
 * is the ordering that matters: a run you cannot stop from the scrollback is
 * a run you cannot stop, and reaching for the mouse first is not an answer.
 *
 * OpenCode registers interrupt as a keymap command scoped to the session
 * rather than as a widget handler, for the same reason:
 * https://github.com/anomalyco/opencode/blob/main/packages/tui/src/config/keybind.ts
 */
export function escapeIntent(state: EscapeState): EscapeIntent {
  if (state.inputMode !== "chat" || state.selecting) return "ignore";
  if (state.busy) return "abort";
  if (state.scrollbackFocused) return "focus_composer";
  return state.hasDraft ? "ignore" : "edit_last_message";
}

export function tuiKeyAction(key: KeyEvent, state: TuiKeyState): TuiKeyAction | undefined {
  if (key.ctrl && key.name === "c" && !state.authenticating) {
    return state.inputMode === "chat" && !state.selecting && state.hasDraft
      ? "clear_for_quit"
      : "shutdown";
  }
  return undefined;
}

/** What shutdown drives on the runner it is tearing down: stop the work, then release it. */
export interface ShutdownTarget {
  close: () => Promise<void>;
}

interface TuiShutdownOptions {
  unsubscribeHarness: () => void;
  getHarness: () => ShutdownTarget;
  repo: { close: () => Promise<void> };
  renderer: { destroy: () => void };
}

export function resumeSessionHint(sessionId: string): string {
  const argument = /^[a-zA-Z0-9._:@%+,=/-]+$/u.test(sessionId)
    ? sessionId
    : `'${sessionId.replaceAll("'", `'\\''`)}'`;
  return `Return to this session: uji --resume ${argument}`;
}

export function createTuiShutdown(options: TuiShutdownOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return () => {
    shutdownPromise ??= (async () => {
      const harness = options.getHarness();
      try {
        options.unsubscribeHarness();
      } catch {}
      try {
        options.renderer.destroy();
      } catch {}
      try {
        await harness.close();
      } catch {}
      try {
        await options.repo.close();
      } catch {}
    })();
    return shutdownPromise;
  };
}
