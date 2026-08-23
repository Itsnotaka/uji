import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { TextareaRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { CHAT_KEYBINDS } from "../src/constants.ts";
import type { ChatCommand } from "../src/constants.ts";
import { createChatKeymap, registerChatLayer } from "../src/keymap.ts";
import type { ChatCommandSpec } from "../src/keymap.ts";

/**
 * The chat layer's whole promise is that a shortcut lands whatever holds focus,
 * so these drive real key events at a real renderer with the composer focused.
 */
void describe("chat keymap", () => {
  let setup: TestRendererSetup;
  let keymap: ReturnType<typeof createChatKeymap>;
  let input: TextareaRenderable;
  let ran: ChatCommand[];
  let enabled: boolean;
  let editable: boolean;
  let declined: Set<ChatCommand>;
  let dispose: () => void;

  const spec = (name: ChatCommand): ChatCommandSpec => ({
    title: name,
    enabled: () => editable,
    run: () => {
      ran.push(name);
      return !declined.has(name);
    },
  });

  before(async () => {
    // Legacy encoding cannot tell ctrl+p from ctrl+shift+p, and sends ctrl+enter
    // as a bare return. The Kitty protocol is what a modern terminal
    // negotiates, and the only one where every binding here is reachable.
    setup = await createTestRenderer({ width: 72, height: 12, kittyKeyboard: true });
    keymap = createChatKeymap(setup.renderer);
  });

  beforeEach(() => {
    for (const child of setup.renderer.root.getChildren()) child.destroyRecursively();
    ran = [];
    enabled = true;
    editable = true;
    declined = new Set();
    input = new TextareaRenderable(setup.renderer, { id: "input", width: "100%", height: 3 });
    setup.renderer.root.add(input);
    input.focus();
    const commands = Object.fromEntries(
      Object.keys(CHAT_KEYBINDS).map((name) => [name, spec(name as ChatCommand)]),
    ) as { readonly [K in ChatCommand]: ChatCommandSpec };
    dispose = registerChatLayer(keymap, { enabled: () => enabled, commands });
  });

  afterEach(() => {
    dispose();
  });

  after(() => {
    setup.renderer.destroy();
  });

  void test("runs shortcuts while the composer holds focus and the keys never reach it", () => {
    setup.mockInput.pressEscape();
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressTab({ shift: true });
    setup.mockInput.pressKey("p", { ctrl: true });

    assert.deepEqual(ran, [
      "chat.interrupt",
      "chat.editor.open",
      "chat.thinking.cycle",
      "chat.model.next",
    ]);
    assert.equal(input.plainText, "");
  });

  void test("keeps running them once focus moves off the composer", () => {
    input.blur();
    setup.mockInput.pressEscape();
    assert.deepEqual(ran, ["chat.interrupt"]);
  });

  void test("tells the two shift variants apart", () => {
    setup.mockInput.pressKey("p", { ctrl: true });
    setup.mockInput.pressKey("p", { ctrl: true, shift: true });
    assert.deepEqual(ran, ["chat.model.next", "chat.model.previous"]);
  });

  void test("a declining command hands the key back to the composer", () => {
    declined.add("chat.commands.open");
    setup.mockInput.pressKey("?");

    assert.deepEqual(ran, ["chat.commands.open"]);
    assert.equal(input.plainText, "?");
  });

  void test("a disabled command hands the key back without running", () => {
    editable = false;
    setup.mockInput.pressKey("g", { ctrl: true });
    // `?` has no editability gate of its own in the real wiring, but here every
    // command shares one, so the whole set steps aside.
    setup.mockInput.pressKey("?");

    assert.deepEqual(ran, []);
    assert.equal(input.plainText, "?");
  });

  void test("a disabled layer leaves every key alone", () => {
    enabled = false;
    setup.mockInput.pressEscape();
    setup.mockInput.pressKey("?");

    assert.deepEqual(ran, []);
    assert.equal(input.plainText, "?");
  });

  void test("all three queue keycaps reach the one command", () => {
    setup.mockInput.pressEnter({ ctrl: true });
    setup.mockInput.pressKey("o", { ctrl: true });

    assert.deepEqual(ran, ["chat.queue.submit", "chat.queue.submit"]);
  });
});
