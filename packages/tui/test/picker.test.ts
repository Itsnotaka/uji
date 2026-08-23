import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CliRenderEvents } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { InlineMenu, PickerCancelled } from "../src/picker.ts";
import type { Choice, MenuScreen } from "../src/picker.ts";
import { THEME } from "../src/theme.ts";

const choices = [
  { id: "alpha", label: "Alpha", description: "First model" },
  { id: "beta", label: "Beta", description: "Fast model" },
  { id: "gamma", label: "Gamma", description: "Reasoning model" },
] as const;

interface OpenMenu {
  menu: InlineMenu;
  /** Settles the way the shell's one-shot `selectChoice` wrapper settles. */
  result: Promise<string>;
}

void describe("inline menu", () => {
  let setup: TestRendererSetup;

  /** The shell mounts the menu under the composer and hands it the input. */
  function open(screen: Omit<MenuScreen, "onSelect" | "onCancel">): OpenMenu {
    let settle: {
      resolve: (id: string) => void;
      reject: (error: Error) => void;
    };
    const result = new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const menu = new InlineMenu(
      { renderer: setup.renderer, theme: THEME },
      {
        ...screen,
        onSelect: (id) => settle.resolve(id),
        onCancel: () => settle.reject(new PickerCancelled()),
      },
    );
    setup.renderer.root.add(menu.container);
    menu.focus();
    return { menu, result };
  }

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 64, height: 20, kittyKeyboard: true });
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("drops into the composer rail and supports typing, cursor edits, and enter", async () => {
    const { result } = open({ title: "Model", choices });
    await setup.renderOnce();

    const initial = setup.captureCharFrame();
    // Inline, not a window: a title but no frame around it.
    assert.match(initial, /Model/);
    assert.doesNotMatch(initial, /[┌┐└┘]/u);

    await setup.mockInput.typeText("gama");
    setup.mockInput.pressArrow("left");
    await setup.mockInput.typeText("m");
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /❯ Gamma/);

    setup.mockInput.pressEnter();
    assert.equal(await result, "gamma");
  });

  void test("clears a query before escape closes the menu", async () => {
    const { menu, result } = open({ title: "Provider", choices });
    await setup.mockInput.typeText("beta");
    setup.mockInput.pressEscape();
    await setup.renderOnce();
    assert.equal(menu.queryInput.value, "");
    assert.match(setup.captureCharFrame(), /Alpha/);

    const cancelled = assert.rejects(result, PickerCancelled);
    setup.mockInput.pressEscape();
    await cancelled;
  });

  void test("selects a row with one click", async () => {
    const { result } = open({ title: "Provider", choices });
    await setup.renderOnce();
    const frame = setup.captureCharFrame().split("\n");
    const y = frame.findIndex((line) => line.includes("Beta"));
    const x = frame[y]?.indexOf("Beta") ?? -1;
    assert.ok(x >= 0 && y >= 0, frame.join("\n"));

    await setup.mockMouse.click(x, y);
    assert.equal(await result, "beta");
  });

  void test("an action key acts on the highlighted row and closes the menu", async () => {
    setup.resize(120, 20);
    const acted: string[] = [];
    const { menu, result } = open({
      title: "Queued messages",
      choices,
      actions: [
        { key: "d", ctrl: true, label: "delete", run: (id) => acted.push(`delete:${id}`) },
        { key: "s", ctrl: true, label: "send now", run: (id) => acted.push(`send:${id}`) },
      ],
    });
    await setup.renderOnce();
    // Keycaps live in the shell's hint row, not in a footer inside the panel.
    assert.equal(
      menu.hints,
      "enter select · ctrl+d delete · ctrl+s send now · ↑↓ move · esc close",
    );

    const cancelled = assert.rejects(result, PickerCancelled);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("d", { ctrl: true });
    await cancelled;
    assert.deepEqual(acted, ["delete:beta"]);
  });

  void test("swaps a screen in place, keeping the composer and the hint verbs", async () => {
    const settings: readonly Choice[] = [
      { id: "transport", label: "Transport", description: "sse" },
    ];
    const { menu } = open({ title: "Settings", choices: settings, selectLabel: "open" });
    await setup.renderOnce();
    assert.equal(menu.hints, "enter open · ↑↓ move · esc close");
    assert.match(setup.captureCharFrame(), /Transport\s+sse/);

    menu.show({
      title: "Transport",
      choices: [
        { id: "sse", label: "sse" },
        { id: "websocket", label: "websocket" },
      ],
      selectedId: "websocket",
      cancelLabel: "back",
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /❯ websocket/);
    assert.doesNotMatch(frame, /Settings/);
    assert.equal(menu.hints, "enter select · ↑↓ move · esc back");
  });

  void test("paints what it has, then lands the slow list behind the frame", async () => {
    let deliver: ((choices: readonly Choice[]) => void) | undefined;
    const loaded = new Promise<readonly Choice[]>((resolve) => {
      deliver = resolve;
    });
    const { menu } = open({
      title: "Model",
      choices: [{ id: "alpha", label: "Alpha", description: "cached" }],
      load: () => loaded,
    });
    await setup.renderOnce();
    // No await before the first frame: the cached row is already on screen.
    assert.match(setup.captureCharFrame(), /Alpha/);

    deliver?.([
      { id: "alpha", label: "Alpha", description: "fresh" },
      { id: "delta", label: "Delta", description: "fresh" },
    ]);
    await loaded;
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /Delta/);
    assert.match(frame, /❯ Alpha/);
    menu.destroy();
  });

  void test("caps the visible rows for a large catalog", async () => {
    setup.resize(80, 50);
    const manyChoices = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${String(index)}`,
      label: `Model ${String(index).padStart(2, "0")}`,
    }));
    const { result } = open({ title: "Model", choices: manyChoices, maxVisible: 12 });
    await setup.renderOnce();

    const visibleModels = setup.captureCharFrame().match(/Model \d{2}/gu) ?? [];
    assert.equal(visibleModels.length, 12);

    const cancelled = assert.rejects(result, PickerCancelled);
    setup.mockInput.pressEscape();
    await cancelled;
  });

  void test("shrinks its row viewport on terminal resize", async () => {
    setup.resize(80, 30);
    const manyChoices = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${String(index)}`,
      label: `Model ${String(index).padStart(2, "0")}`,
    }));
    const resizeListeners = setup.renderer.listenerCount(CliRenderEvents.RESIZE);
    const { menu, result } = open({ title: "Model", choices: manyChoices, maxVisible: 12 });
    await setup.renderOnce();
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.RESIZE), resizeListeners + 1);
    assert.equal(setup.captureCharFrame().match(/Model \d{2}/gu)?.length, 12);

    setup.resize(80, 10);
    await setup.renderOnce();
    const resized = setup.captureCharFrame();
    assert.equal(resized.match(/Model \d{2}/gu)?.length, 3, resized);

    const cancelled = assert.rejects(result, PickerCancelled);
    setup.mockInput.pressEscape();
    await cancelled;
    menu.destroy();
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.RESIZE), resizeListeners);
  });
});
