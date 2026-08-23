import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { KeyEvent } from "@opentui/core";
import {
  createTuiShutdown,
  DOUBLE_ESCAPE_MS,
  DoubleEscape,
  escapeIntent,
  isComposerTextKey,
  nextThinkingLevel,
  resumeSessionHint,
  TuiFocusController,
  tuiKeyAction,
} from "../src/lifecycle.ts";
import { CTRL_C_EXIT_HINT } from "../src/constants.ts";

function key(patch: Partial<ConstructorParameters<typeof KeyEvent>[0]> = {}): KeyEvent {
  return new KeyEvent({
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
    ...patch,
  });
}

void describe("TUI lifecycle", () => {
  void test("ctrl+c clears a draft before shutting down", () => {
    assert.equal(
      tuiKeyAction(key({ name: "c", ctrl: true }), {
        selecting: false,
        inputMode: "chat",
        authenticating: false,
        hasDraft: true,
      }),
      "clear_for_quit",
    );
    assert.equal(
      tuiKeyAction(key({ name: "c", ctrl: true }), {
        selecting: false,
        inputMode: "chat",
        authenticating: false,
        hasDraft: false,
      }),
      "shutdown",
    );
    assert.equal(CTRL_C_EXIT_HINT, "ctrl+c again to quit");
  });

  void test("prints a copyable command for the current session", () => {
    assert.equal(
      resumeSessionHint("2026-08-22T18-30-00.000Z-s_1234abcd"),
      "Return to this session: uji --resume 2026-08-22T18-30-00.000Z-s_1234abcd",
    );
    assert.equal(
      resumeSessionHint("session with 'quotes'"),
      "Return to this session: uji --resume 'session with '\\''quotes'\\'''",
    );
  });

  void test("escape stops the run from either pane", () => {
    const busy = {
      selecting: false,
      inputMode: "chat",
      authenticating: false,
      hasDraft: false,
      busy: true,
      scrollbackFocused: false,
    } as const;

    assert.equal(escapeIntent(busy), "abort");
    // The scrollback used to swallow escape and only hand focus back, which
    // left a run unstoppable until you clicked into the composer.
    assert.equal(escapeIntent({ ...busy, scrollbackFocused: true }), "abort");
    assert.equal(escapeIntent({ ...busy, hasDraft: true }), "abort");
  });

  void test("an idle escape leaves the scrollback before it rewinds a message", () => {
    const idle = {
      selecting: false,
      inputMode: "chat",
      authenticating: false,
      hasDraft: false,
      busy: false,
      scrollbackFocused: false,
    } as const;

    assert.equal(escapeIntent({ ...idle, scrollbackFocused: true }), "focus_composer");
    assert.equal(escapeIntent(idle), "edit_last_message");
    // A draft is the message you are writing, not the one you want back.
    assert.equal(escapeIntent({ ...idle, hasDraft: true }), "ignore");
  });

  void test("escape does nothing while a menu or login owns input", () => {
    const busy = {
      selecting: false,
      inputMode: "chat",
      authenticating: false,
      hasDraft: false,
      busy: true,
      scrollbackFocused: false,
    } as const;

    assert.equal(escapeIntent({ ...busy, selecting: true }), "ignore");
    assert.equal(escapeIntent({ ...busy, inputMode: "auth" }), "ignore");
  });

  void test("escape is not a quit key", () => {
    assert.equal(
      tuiKeyAction(key({ name: "escape" }), {
        selecting: false,
        inputMode: "chat",
        authenticating: false,
        hasDraft: true,
      }),
      undefined,
    );
  });

  void test("a second escape closes the pair only inside the window", () => {
    const gesture = new DoubleEscape();
    assert.equal(gesture.press(1_000), false);
    assert.equal(gesture.press(1_000 + DOUBLE_ESCAPE_MS - 1), true);
    // The pair is spent, so the next press starts over instead of firing again.
    assert.equal(gesture.press(1_000 + DOUBLE_ESCAPE_MS), false);
    assert.equal(gesture.press(1_000 + DOUBLE_ESCAPE_MS * 2), false);
    assert.equal(gesture.press(1_000 + DOUBLE_ESCAPE_MS * 2 + 1), true);
  });

  void test("restores the active editor after a terminal or pane switch", () => {
    const calls: string[] = [];
    const chat = {
      focus: () => calls.push("chat.focus"),
      blur: () => calls.push("chat.blur"),
    };
    const dialog = {
      focus: () => calls.push("dialog.focus"),
      blur: () => calls.push("dialog.blur"),
    };
    const focus = new TuiFocusController(chat);

    focus.restore();
    focus.use(dialog);
    assert.equal(focus.isUsing(dialog), true);
    focus.blur();
    focus.restore();
    focus.reset();
    assert.equal(focus.isUsing(chat), true);

    assert.deepEqual(calls, [
      "chat.focus",
      "dialog.focus",
      "dialog.blur",
      "dialog.focus",
      "chat.focus",
    ]);
  });

  void test("cycles through only the thinking levels supported by the model", () => {
    assert.equal(nextThinkingLevel("low", ["off", "low", "high"]), "high");
    assert.equal(nextThinkingLevel("high", ["off", "low", "high"]), "off");
    assert.equal(nextThinkingLevel("medium", ["off", "high"]), "off");
    assert.equal(nextThinkingLevel("off", ["off"]), undefined);
  });

  void test("forwards only printable scrollback keys to the composer", () => {
    assert.equal(isComposerTextKey(key({ name: "h", sequence: "h" })), true);
    assert.equal(isComposerTextKey(key({ name: "up", sequence: "\u001b[A" })), false);
    assert.equal(isComposerTextKey(key({ name: "c", sequence: "c", ctrl: true })), false);
  });

  void test("doesn't focus a new owner while the terminal is inactive", () => {
    const calls: string[] = [];
    const chat = {
      focus: () => calls.push("chat.focus"),
      blur: () => calls.push("chat.blur"),
    };
    const dialog = {
      focus: () => calls.push("dialog.focus"),
      blur: () => calls.push("dialog.blur"),
    };
    const focus = new TuiFocusController(chat);

    focus.blur();
    focus.use(dialog);
    focus.restore();

    assert.deepEqual(calls, ["chat.blur", "dialog.blur", "dialog.focus"]);
  });

  void test("shutdown restores the terminal before closing active work", async () => {
    const calls: string[] = [];
    let finishClose: (() => void) | undefined;
    const closingTarget = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const shutdown = createTuiShutdown({
      unsubscribeHarness: () => calls.push("unsubscribe"),
      getHarness: () => ({
        close: () => {
          calls.push("harness.close");
          return closingTarget;
        },
      }),
      repo: {
        close: () => {
          calls.push("repo.close");
          return Promise.resolve();
        },
      },
      renderer: { destroy: () => calls.push("renderer.destroy") },
    });

    const closing = shutdown();
    assert.deepEqual(calls, ["unsubscribe", "renderer.destroy", "harness.close"]);
    assert.ok(finishClose !== undefined);
    finishClose();
    await closing;
    assert.deepEqual(calls, ["unsubscribe", "renderer.destroy", "harness.close", "repo.close"]);
  });

  void test("a throwing UI disposer cannot skip harness and repository cleanup", async () => {
    const calls: string[] = [];
    const shutdown = createTuiShutdown({
      unsubscribeHarness: () => {
        calls.push("unsubscribe");
        throw new Error("broken disposer");
      },
      getHarness: () => ({
        close: () => {
          calls.push("harness.close");
          return Promise.resolve();
        },
      }),
      repo: {
        close: () => {
          calls.push("repo.close");
          return Promise.resolve();
        },
      },
      renderer: {
        destroy: () => {
          calls.push("renderer.destroy");
          throw new Error("broken renderer");
        },
      },
    });

    await shutdown();
    assert.deepEqual(calls, ["unsubscribe", "renderer.destroy", "harness.close", "repo.close"]);
  });
});
