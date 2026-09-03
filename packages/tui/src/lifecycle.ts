import type { KeyEvent } from "@opentui/core";
import type { ThinkingLevel } from "@uji-ai/core";

type TuiKeyAction = "clear_for_quit" | "shutdown";

/** How long a second escape still counts as part of the same gesture. */
export const DOUBLE_ESCAPE_MS = 500;

/**
 * Escape twice on an empty composer opens the session tree.
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

interface TuiKeyState {
  selecting: boolean;
  inputMode: "chat" | "auth";
  authenticating: boolean;
  hasDraft: boolean;
}

interface TuiFocusTarget {
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

/** A printable key that belongs to the composer. */
export function isComposerTextKey(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.option === true || key.super === true) return false;
  const first = key.sequence.charCodeAt(0);
  return key.sequence !== "" && first >= 32 && first !== 127;
}

/** The one thing escape can mean right now. */
type EscapeIntent = "abort" | "open_tree" | "ignore";

interface EscapeState extends TuiKeyState {
  /** A run or a compaction is in flight, so there is work to interrupt. */
  busy: boolean;
}

/** Resolve escape before the focused editor sees it. */
export function escapeIntent(state: EscapeState): EscapeIntent {
  if (state.inputMode !== "chat" || state.selecting) return "ignore";
  if (state.busy) return "abort";
  return state.hasDraft ? "ignore" : "open_tree";
}

/** What a stopped run leaves behind on screen. */
type StoppedTurnIntent = "retract" | "keep";

interface StoppedTurnState {
  /** The turn drew the request and nothing that answers it. */
  unanswered: boolean;
  /** The composer already holds text that a returning message would overwrite. */
  hasDraft: boolean;
}

/**
 * Escape that lands before the model says anything leaves a request with a
 * `! Stopped` line under it, and that line is a dead end: the text you wanted
 * to fix is now in the record, and getting it back costs a second escape and a
 * picker. So a run stopped with nothing under it hands the message straight
 * back to the composer, which is the same round trip double-escape makes.
 *
 * Two cases keep the stopped line. A turn that produced a thought, a reply, or
 * a tool call is a turn worth keeping, and the message that opened it is no
 * longer the only thing on screen. A composer that already holds a draft has
 * nowhere to put the returning text without destroying what is typed there.
 */
export function stoppedTurnIntent(state: StoppedTurnState): StoppedTurnIntent {
  return state.unanswered && !state.hasDraft ? "retract" : "keep";
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
interface ShutdownTarget {
  close: () => Promise<void>;
}

interface TuiShutdownOptions {
  unsubscribeHarness: () => void;
  getHarness: () => ShutdownTarget;
  /** Closed after the host; absent when the host owns its own store. */
  repo?: { close: () => Promise<void> };
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
        await options.repo?.close();
      } catch {}
    })();
    return shutdownPromise;
  };
}
