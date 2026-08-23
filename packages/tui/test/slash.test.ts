import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BoxRenderable, InputRenderable, KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { SlashAutocomplete } from "../src/slash-autocomplete.ts";
import {
  availableSlashCommands,
  resolveSlashCommand,
  skillPaletteItems,
  SLASH_COMMANDS,
  slashCommandLabel,
  slashSuggestions,
} from "../src/slash.ts";
import type { SlashCommand } from "../src/slash.ts";
import type { DirectorySuggestion } from "../src/directory-autocomplete.ts";
import type { Command } from "@uji-ai/core";
import type { Skill } from "@uji-ai/schema";
import { THEME } from "../src/theme.ts";
import { buildUi } from "../src/tui.ts";

/** Widened so the optional `argument` is readable on every entry. */
const REGISTERED: readonly SlashCommand[] = SLASH_COMMANDS;

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
    assert.notEqual(slashSuggestions("/"), undefined);
    assert.notEqual(slashSuggestions("/pro"), undefined);
    assert.equal(slashSuggestions("hello /pro"), undefined);
    assert.equal(slashSuggestions("/provider "), undefined);
  });

  void test("sorts commands alphabetically and resolves aliases", () => {
    assert.deepEqual(
      slashSuggestions("/")?.map((command) => command.name),
      [...SLASH_COMMANDS]
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((command) => command.name),
    );
    assert.equal(slashSuggestions("/mo")?.[0]?.name, "model");
    assert.equal(slashSuggestions("/ed")?.[0]?.name, "edit");
    const re = slashSuggestions("/re")?.map((command) => command.name);
    assert.deepEqual(re?.slice(0, 2), ["resume", "reload"]);
    assert.equal(re?.includes("tree"), true);
    assert.equal(re?.length, 10);
    assert.equal(slashSuggestions("/prev")?.[0]?.name, "resume");
    assert.equal(slashSuggestions("/cont")?.[0]?.name, "resume");
    assert.equal(resolveSlashCommand("providers")?.name, "provider");
    assert.equal(resolveSlashCommand("continue")?.name, "resume");
    assert.equal(resolveSlashCommand("thinking")?.name, "effort");
    assert.equal(resolveSlashCommand("exit")?.name, "quit");
    assert.equal(resolveSlashCommand("settings")?.description, "Change settings");
    assert.equal(resolveSlashCommand("skills")?.name, "skills");
    const name = resolveSlashCommand("name");
    assert.equal(name === undefined ? undefined : slashCommandLabel(name), "/name <name>");
    const model = resolveSlashCommand("model");
    assert.equal(model === undefined ? undefined : slashCommandLabel(model), "/model");
  });

  void test("projects skills as direct commands without shadowing static or plugin commands", () => {
    const plugins = new Map<string, Command>([
      ["fast", { description: "Toggle fast inference", run: () => undefined }],
    ]);
    const skill = (name: string): Skill => ({
      name,
      description: `Use ${name}`,
      content: "Instructions",
      filePath: `/skills/${name}/SKILL.md`,
    });
    const commands = availableSlashCommands(
      plugins,
      new Map([
        ["typescript-best-practices", skill("typescript-best-practices")],
        ["help", skill("help")],
        ["fast", skill("fast")],
      ]),
    );

    const projected = commands.find((command) => command.name === "typescript-best-practices");
    assert.equal(projected?.description, "Use typescript-best-practices");
    assert.equal(projected?.argument?.kind, "prompt");
    assert.equal(commands.filter((command) => command.name === "help").length, 1);
    assert.equal(commands.filter((command) => command.name === "fast").length, 1);
  });

  void test("lists skills A–Z for the dedicated palette", () => {
    const skill = (name: string): Skill => ({
      name,
      description: `Use ${name}`,
      content: "Instructions",
      filePath: `/skills/${name}/SKILL.md`,
    });
    assert.deepEqual(
      skillPaletteItems(
        new Map([
          ["unslop", skill("unslop")],
          ["review", skill("review")],
        ]),
      ).map((item) => item.id),
      ["review", "unslop"],
    );
  });
});

void describe("slash autocomplete", () => {
  let setup: TestRendererSetup;
  let input: InputRenderable;
  let autocomplete: SlashAutocomplete;
  let selected: SlashCommand[];
  let directories: readonly DirectorySuggestion[];
  let directoryRequests: number;

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
    directories = [];
    directoryRequests = 0;
    let id = 0;
    autocomplete = new SlashAutocomplete({
      renderer: setup.renderer,
      input,
      theme: THEME,
      nextId: (prefix = "n") => `${prefix}-${String(id++)}`,
      onCommand(command) {
        selected.push(command);
      },
      onFile(path) {
        return `[File ${path}]`;
      },
      completeDirectories() {
        directoryRequests += 1;
        return Promise.resolve(directories);
      },
    });
    root.add(input);
    root.add(autocomplete.container);
    setup.renderer.root.add(root);
    input.focus();
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("draws the rows on the composer's rail with no panel fill", async () => {
    input.value = "/";
    autocomplete.update(input.value);
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const rows = lines.filter((line) => /\/(cd|help|new)\b/.test(line));
    assert.ok(rows.length >= 3, lines.join("\n"));
    // Every row starts in the same column as the composer's prompt glyph, and
    // a blank row breathes above the list.
    for (const row of rows) assert.match(row, /^ {3}[❯ ]/);
    const first = lines.findIndex((line) => /\/cd <directory>/.test(line));
    assert.equal(lines[first - 1]?.trim(), "");
  });

  void test("renders inline below the focused input", async () => {
    input.value = "/";
    autocomplete.update(input.value);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /\/cd <directory>\s+Change the working directory/);
    assert.match(frame, /\/help\s+Browse commands/);
    assert.match(frame, /\/new\s+Start a new chat/);
    assert.match(frame, /\/name <name>\s+Name the current chat/);
    const first = frame.split("\n").find((line) => line.includes("/cd <directory>"));
    assert.equal(first?.trimStart().startsWith("❯ /cd"), true, frame);
  });

  void test("gives rows back before it pushes hints out of a short terminal", async () => {
    for (const child of setup.renderer.root.getChildren()) child.destroyRecursively();
    const ui = buildUi(setup.renderer, THEME);
    let id = 0;
    const compact = new SlashAutocomplete({
      renderer: setup.renderer,
      input: ui.input,
      theme: THEME,
      nextId: (prefix = "n") => `${prefix}-${String(id++)}`,
      onCommand: () => undefined,
      onFile: (path) => path,
      completeDirectories: () => Promise.resolve([]),
    });
    ui.root.insertBefore(compact.container, ui.hints);
    compact.update("/");

    setup.resize(40, 10);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /\/cd/);
    assert.match(frame, /commands/);
    assert.ok(compact.container.screenY + compact.container.height <= ui.hints.screenY);
    assert.ok(ui.hints.screenY < setup.renderer.height);

    compact.destroy();
  });

  void test("completes file mentions into compact composer tags", async () => {
    input.value = "inspect @read";
    autocomplete.update(input.value, REGISTERED, [
      { path: "/workspace/README.md", displayPath: "README.md", label: "README.md" },
    ]);
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /README\.md/);

    assert.equal(autocomplete.handleKey(key("return")), true);
    assert.equal(input.value, "inspect [File /workspace/README.md] ");
  });

  void test("completes /cd arguments from the selected directory", async () => {
    directories = [{ completion: "../core/" }, { completion: "../tui/" }];
    input.value = "/cd ../";
    autocomplete.update(input.value);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /\.\.\/core\//);

    assert.equal(autocomplete.handleKey(key("tab")), true);
    assert.equal(input.value, "/cd ../core/");
    assert.equal(autocomplete.visible, false);
  });

  void test("ranks both /re prefixes first and keeps fuzzy matches", async () => {
    input.value = "/re";
    autocomplete.update(input.value);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.ok(frame.indexOf("/resume") < frame.indexOf("/reload"), frame);
    assert.ok(frame.indexOf("/reload") < frame.indexOf("/tree"), frame);
  });

  void test("discovers commands contributed by active plugins", async () => {
    const commands = [...REGISTERED, { name: "fast", description: "Toggle fast inference" }];
    input.value = "/fas";
    autocomplete.update(input.value, commands);
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /\/fast\s+Toggle fast inference/);

    assert.equal(autocomplete.handleKey(key("return")), true);
    assert.equal(selected[0]?.name, "fast");
    assert.equal(input.value, "");
  });

  void test("does not reset selection when the textarea repeats the projected value", () => {
    input.value = "/re";
    autocomplete.update(input.value);
    assert.equal(autocomplete.handleKey(key("down")), true);
    autocomplete.update(input.value);
    assert.equal(autocomplete.handleKey(key("tab")), true);
    assert.equal(input.value, "/reload");
  });

  void test("Enter and Tab follow the explicit contract for every registered command", () => {
    for (const command of REGISTERED) {
      selected.length = 0;
      input.value = `/${command.name}`;
      autocomplete.update(input.value);
      assert.equal(autocomplete.handleKey(key("return")), true);
      if (command.argument?.kind === "required") {
        assert.equal(input.value, `/${command.name} `, `/${command.name} completes`);
        assert.deepEqual(selected, [], `/${command.name} does not execute`);
      } else {
        assert.equal(selected[0]?.name, command.name, `/${command.name} executes`);
        assert.equal(input.value, "", `/${command.name} clears the composer`);
      }
      assert.equal(autocomplete.visible, false);

      selected.length = 0;
      input.value = `/${command.name}`;
      autocomplete.update(input.value);
      assert.equal(autocomplete.handleKey(key("tab")), true);
      assert.equal(
        input.value,
        `/${command.name}${command.argument === undefined ? "" : " "}`,
        `/${command.name} completes on Tab`,
      );
      assert.deepEqual(selected, [], `/${command.name} does not execute on Tab`);
    }
  });

  void test("Enter executes the selected command from a partial name or alias", () => {
    input.value = "/log";
    autocomplete.update(input.value);
    assert.equal(autocomplete.handleKey(key("return")), true);
    assert.equal(selected[0]?.name, "login");
    assert.equal(input.value, "");

    input.value = "/thi";
    autocomplete.update(input.value);
    assert.equal(autocomplete.handleKey(key("return")), true);
    assert.equal(selected[1]?.name, "effort");
    assert.equal(input.value, "");

    input.value = "/c";
    autocomplete.update(input.value);
    autocomplete.handleKey(key("return"));
    assert.equal(input.value, "/cd ");
    assert.equal(selected.length, 2);
  });

  void test("mouse acceptance uses the same execute-or-complete contract", async () => {
    input.value = "/login";
    autocomplete.update(input.value);
    await setup.renderOnce();
    let frame = setup.captureCharFrame().split("\n");
    // The composer echoes the draft, so match the menu row by its description.
    let y = frame.findIndex((line) => line.includes("Log in to a provider"));
    let x = frame[y]?.indexOf("/login") ?? -1;
    assert.ok(x >= 0 && y >= 0, frame.join("\n"));
    await setup.mockMouse.click(x, y);
    assert.equal(selected[0]?.name, "login");
    assert.equal(input.value, "");

    input.value = "/name";
    autocomplete.update(input.value);
    await setup.renderOnce();
    frame = setup.captureCharFrame().split("\n");
    y = frame.findIndex((line) => line.includes("Name the current chat"));
    x = frame[y]?.indexOf("/name") ?? -1;
    assert.ok(x >= 0 && y >= 0, frame.join("\n"));
    await setup.mockMouse.click(x, y);
    assert.equal(input.value, "/name ");
    assert.equal(selected.length, 1);
  });

  void test("Tab completes a partial name to the command", () => {
    input.value = "/log";
    autocomplete.update(input.value);
    assert.equal(autocomplete.handleKey(key("tab")), true);
    assert.equal(input.value, "/login ");
    assert.deepEqual(selected, []);
  });

  void test("escape keeps completion closed while the slash draft changes", () => {
    input.value = "/";
    autocomplete.update(input.value);
    const escape = key("escape");
    autocomplete.handleKey(escape);

    input.value = "/input";
    autocomplete.update(input.value);
    const submit = key("return");
    assert.equal(autocomplete.handleKey(submit), false);
    assert.equal(input.value, "/input");
    assert.deepEqual(selected, []);
    assert.equal(autocomplete.visible, false);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(submit.defaultPrevented, false);

    input.value = "plain prompt";
    autocomplete.update(input.value);
    input.value = "/";
    autocomplete.update(input.value);
    assert.equal(autocomplete.visible, true);
  });

  void test("escape stops directory lookups until the completion session ends", () => {
    input.value = "/cd p";
    autocomplete.update(input.value);
    assert.equal(directoryRequests, 1);
    autocomplete.handleKey(key("escape"));

    input.value = "/cd pa";
    autocomplete.update(input.value);
    input.value = "/cd pac";
    autocomplete.update(input.value);
    assert.equal(directoryRequests, 1);
    assert.equal(autocomplete.visible, false);

    input.value = "plain prompt";
    autocomplete.update(input.value);
    input.value = "/cd ";
    autocomplete.update(input.value);
    assert.equal(directoryRequests, 2);
    assert.equal(autocomplete.visible, true);
  });

  void test("escape closes a no-match file menu and keeps the draft", () => {
    const draft = "how does pi handle it @earendil-works/pi-coding-agent";
    input.value = draft;
    autocomplete.update(input.value, REGISTERED, []);
    const event = key("escape");
    autocomplete.handleKey(event);
    assert.equal(input.value, draft);
    assert.equal(autocomplete.visible, false);
    assert.equal(event.defaultPrevented, true);

    input.value = `${draft}-core`;
    autocomplete.update(input.value, REGISTERED, []);
    assert.equal(autocomplete.visible, false);
  });
});
