import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BoxRenderable, InputRenderable, KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { SlashAutocomplete } from "../src/slash-autocomplete.ts";
import { resolveSlashCommand, slashQuery, slashSuggestions } from "../src/slash.ts";
import type { SlashCommand } from "../src/slash.ts";
import { createTheme } from "../src/theme.ts";

function key(name: string): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  });
}

void describe("slash command registry", () => {
  void test("opens only for a leading command token", () => {
    assert.equal(slashQuery("/"), "");
    assert.equal(slashQuery("/pro"), "pro");
    assert.equal(slashQuery("hello /pro"), undefined);
    assert.equal(slashQuery("/provider "), undefined);
  });

  void test("keeps the registry order and resolves aliases", () => {
    assert.deepEqual(
      slashSuggestions("/")
        .slice(0, 3)
        .map((command) => command.name),
      ["help", "login", "provider"],
    );
    assert.equal(slashSuggestions("/mo")[0]?.name, "model");
    assert.equal(resolveSlashCommand("providers")?.name, "provider");
    assert.equal(resolveSlashCommand("cd")?.acceptsArgument, true);
  });
});

void describe("slash autocomplete", () => {
  let setup: TestRendererSetup;
  let input: InputRenderable;
  let autocomplete: SlashAutocomplete;
  let selected: SlashCommand[];

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 72, height: 24 });
    const root = new BoxRenderable(setup.renderer, {
      id: "app",
      width: "100%",
      height: "100%",
      flexDirection: "column",
    });
    input = new InputRenderable(setup.renderer, { id: "input" });
    selected = [];
    let id = 0;
    autocomplete = new SlashAutocomplete({
      renderer: setup.renderer,
      input,
      theme: createTheme("light"),
      nextId: (prefix = "n") => `${prefix}-${String(id++)}`,
      onCommand(command) {
        selected.push(command);
      },
    });
    root.add(autocomplete.container);
    root.add(input);
    setup.renderer.root.add(root);
    input.focus();
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("renders inline above the focused input", async () => {
    input.value = "/";
    autocomplete.update(input.value);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /\/help\s+Show every command/);
    assert.match(frame, /\/login\s+Log in to a provider/);
    assert.match(frame, /\/provider\s+Switch provider/);
  });

  void test("executes exact commands and completes argument commands", () => {
    input.value = "/login";
    autocomplete.update(input.value);
    assert.equal(autocomplete.handleKey(key("return")), true);
    assert.equal(selected[0]?.name, "login");
    assert.equal(input.value, "");

    input.value = "/c";
    autocomplete.update(input.value);
    autocomplete.handleKey(key("return"));
    assert.equal(input.value, "/cd ");
    assert.equal(selected.length, 1);

    input.value = "/cd";
    autocomplete.update(input.value);
    autocomplete.handleKey(key("return"));
    assert.equal(selected[1]?.name, "cd");
  });

  void test("escape closes completion and clears the unfinished command", () => {
    input.value = "/pro";
    autocomplete.update(input.value);
    const event = key("escape");
    autocomplete.handleKey(event);
    assert.equal(input.value, "");
    assert.equal(autocomplete.visible, false);
    assert.equal(event.defaultPrevented, true);
  });
});
