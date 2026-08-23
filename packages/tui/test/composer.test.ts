import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CliRenderEvents, KeyEvent, PasteEvent } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";
import type { TestRendererSetup } from "@opentui/core/testing";
import { buildUi, flash, FLASH_MS, framedPowerline, selectChoice } from "../src/tui.ts";
import {
  ComposerParts,
  discoverMentionFiles,
  fileAttachmentBlock,
  foldAttachments,
  fileMentionQuery,
  fileMentionSuggestions,
  PromptHistory,
  resolveComposerImagePaste,
  resolveComposerPaste,
} from "../src/composer.ts";
import { composerPartTagLabel } from "../src/composer-tags.ts";
import type { PowerlineState } from "../src/format.ts";
import { THEME } from "../src/theme.ts";

const status: PowerlineState = {
  runState: "idle",
  workspace: "uji",
  branch: "main",
  dirty: false,
  model: "gpt-5.6-luna",
  effort: "medium",
  fast: false,
  queued: 0,
};

function key(
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): KeyEvent {
  return new KeyEvent({
    name,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
    option: modifiers.meta ?? false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  });
}

void describe("composer frame", () => {
  let setup: TestRendererSetup;
  const clock = new ManualClock();

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 64, height: 18, clock });
  });

  afterEach(() => {
    setup.renderer.destroy();
  });

  void test("keeps the model visible at narrow, normal and wide widths", async () => {
    for (const [width, height] of [
      [60, 24],
      [80, 30],
      [120, 40],
    ] as const) {
      setup.resize(width, height);
      for (const child of setup.renderer.root.getChildren()) child.destroyRecursively();
      const theme = THEME;
      const ui = buildUi(setup.renderer, theme);
      await setup.renderOnce();
      ui.powerline.content = framedPowerline(status, ui.powerline.width, theme);
      await setup.renderOnce();
      assert.match(setup.captureCharFrame(), /gpt-5\.6-luna/, `width ${String(width)}`);
    }
  });

  void test("uses a continuous rounded border with side breathing room", async () => {
    buildUi(setup.renderer, THEME);
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const contentRow = lines.findIndex((line) => line.includes("Plan, search, build anything"));
    assert.ok(contentRow > 0, lines.join("\n"));
    assert.match(lines[contentRow - 1] ?? "", /^ ╭─+╮ $/);
    assert.match(lines[contentRow] ?? "", /^ │\s+❯ Plan, search, build anything.*│ $/);
    assert.match(lines[contentRow + 1] ?? "", /^ ╰─+╯ $/);
    assert.doesNotMatch(lines.slice(contentRow - 1, contentRow + 2).join(""), /[┄┅┈┉╌╍]/);
  });

  void test("separates hint keycaps from what they do", async () => {
    const theme = THEME;
    buildUi(setup.renderer, theme);
    await setup.renderOnce();
    const line = setup
      .captureSpans()
      .lines.find((candidate) => candidate.spans.some((span) => span.text.includes("commands")));
    assert.ok(line !== undefined);
    const cap = line.spans.find((span) => span.text === "shift+tab");
    const label = line.spans.find((span) => span.text === " thinking");
    const separator = line.spans.find((span) => span.text.trim() === "·");
    assert.ok(cap !== undefined && label !== undefined && separator !== undefined);
    assert.notDeepEqual(cap.fg.toInts(), label.fg.toInts());
    assert.notDeepEqual(label.fg.toInts(), separator.fg.toInts());
  });

  void test("flashes status on the hint row and gives the row back", async () => {
    const ui = buildUi(setup.renderer, THEME);
    await setup.renderOnce();
    flash(ui, "Nothing is queued");
    flash(ui, "Nothing is queued");
    flash(ui, "Nothing is queued");
    await setup.renderOnce();
    const flashed = setup.captureCharFrame();
    // One row however many times the key was pressed, and nothing above the
    // composer.
    assert.equal(flashed.match(/Nothing is queued/gu)?.length, 1);
    assert.doesNotMatch(flashed, /commands/u);

    clock.advance(FLASH_MS);
    await setup.renderOnce();
    const restored = setup.captureCharFrame();
    assert.doesNotMatch(restored, /Nothing is queued/u);
    assert.match(restored, /commands/u);
  });

  void test("a flash stops asking for frames once it clears", async () => {
    const ui = buildUi(setup.renderer, THEME);
    flash(ui, "Removed from the queue");
    assert.equal(ui.hints.live, true);
    clock.advance(FLASH_MS);
    await setup.renderOnce();
    assert.equal(ui.hints.live, false);
  });

  void test("colors powerline roles instead of painting one dim caption", async () => {
    const theme = THEME;
    const ui = buildUi(setup.renderer, theme);
    await setup.renderOnce();
    ui.powerline.content = framedPowerline(status, ui.powerline.width, theme);
    await setup.renderOnce();

    const line = setup
      .captureSpans()
      .lines.find((candidate) =>
        candidate.spans.some((span) => span.text.includes("gpt-5.6-luna")),
      );
    assert.ok(line !== undefined);
    const workspace = line.spans.find((span) => span.text === "uji main");
    const model = line.spans.find((span) => span.text === "gpt-5.6-luna");
    const effort = line.spans.find((span) => span.text === "medium");
    assert.ok(workspace !== undefined && model !== undefined && effort !== undefined);
    assert.notDeepEqual(workspace.fg.toInts(), model.fg.toInts());
    assert.notDeepEqual(model.fg.toInts(), effort.fg.toInts());
  });

  void test("restores composer focus when the terminal regains focus", () => {
    const ui = buildUi(setup.renderer, THEME);
    assert.equal(setup.renderer.currentFocusedRenderable, ui.input);

    setup.renderer.emit(CliRenderEvents.BLUR);
    assert.equal(setup.renderer.currentFocusedRenderable, null);

    setup.renderer.emit(CliRenderEvents.FOCUS);
    assert.equal(setup.renderer.currentFocusedRenderable, ui.input);
  });

  void test("releases renderer listeners when its root is destroyed", () => {
    const before = {
      blur: setup.renderer.listenerCount(CliRenderEvents.BLUR),
      focus: setup.renderer.listenerCount(CliRenderEvents.FOCUS),
      resize: setup.renderer.listenerCount(CliRenderEvents.RESIZE),
    };
    const ui = buildUi(setup.renderer, THEME);
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.BLUR), before.blur + 1);
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.FOCUS), before.focus + 1);
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.RESIZE), before.resize + 1);

    ui.root.destroyRecursively();
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.BLUR), before.blur);
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.FOCUS), before.focus);
    assert.equal(setup.renderer.listenerCount(CliRenderEvents.RESIZE), before.resize);
  });

  void test("rejects an empty picker without trapping input in selection mode", async () => {
    const ui = buildUi(setup.renderer, THEME);
    await assert.rejects(selectChoice(ui, "Nothing to choose", []), /at least 1 choice/);
    assert.equal(ui.selecting, false);
    assert.equal(setup.renderer.currentFocusedRenderable, ui.input);
  });

  void test("submits with enter and inserts newlines with shift or alt enter", async () => {
    const ui = buildUi(setup.renderer, THEME);
    let submits = 0;
    ui.input.onSubmit = () => submits++;
    ui.input.insertText("first");
    ui.input.handleKeyPress(key("return", { shift: true }));
    ui.input.insertText("second");
    ui.input.handleKeyPress(key("return", { meta: true }));
    ui.input.insertText("third");

    assert.equal(ui.input.plainText, "first\nsecond\nthird");
    await setup.renderOnce();
    assert.equal(ui.inputBox.height, 4);
    ui.input.handleKeyPress(key("return"));
    assert.equal(submits, 1);
    assert.equal(ui.input.plainText, "first\nsecond\nthird");
  });

  void test("grows immediately when a bracketed paste adds lines", async () => {
    const ui = buildUi(setup.renderer, THEME);
    ui.input.handlePaste(new PasteEvent(new TextEncoder().encode("one\ntwo\nthree\nfour")));

    await setup.renderOnce();
    assert.equal(ui.input.plainText, "one\ntwo\nthree\nfour");
    assert.equal(ui.inputBox.height, 5);
  });

  void test("caps a long draft before it pushes status chrome off-screen", async () => {
    setup.resize(40, 10);
    const ui = buildUi(setup.renderer, THEME);
    ui.input.insertText(
      Array.from({ length: 12 }, (_, index) => `line ${String(index)}`).join("\n"),
    );
    await setup.renderOnce();

    assert.ok(ui.inputBox.height < setup.renderer.height);
    assert.ok(ui.powerline.screenY < setup.renderer.height);
    assert.ok(ui.hints.screenY < setup.renderer.height);
    assert.ok(ui.scroll.height >= 1);

    setup.resize(40, 8);
    await setup.renderOnce();
    assert.ok(ui.powerline.screenY < setup.renderer.height);
    assert.ok(ui.hints.screenY < setup.renderer.height);
    assert.ok(ui.scroll.height >= 1);
  });
});

void describe("rich composer parts", () => {
  void test("lists retained parts with labels derived from their markers", () => {
    const parts = new ComposerParts();
    parts.addFile("/tmp/listed.ts");
    const paste = parts.addPaste("one\ntwo\nthree");
    parts.addImage({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });

    assert.deepEqual(
      parts.current.map((part) => part.marker),
      ["[File listed.ts]", "[Paste #1 3 lines]", "[Image 1]"],
    );
    assert.deepEqual(parts.current.map(composerPartTagLabel), [
      " File listed.ts ",
      " Paste #1 3 lines ",
      " Image 1 ",
    ]);

    parts.retain(`keep ${paste}`);
    assert.deepEqual(
      parts.current.map((part) => part.marker),
      [paste],
    );
    parts.clear();
    assert.deepEqual(parts.current, []);
  });

  void test("keeps a rendered part snapshot stable when another part is added", () => {
    const parts = new ComposerParts();
    const first = parts.addPaste("a\nb\nc");
    parts.retain(`draft ${first}`);
    const rendered = parts.current;

    const second = parts.addPaste("d\ne\nf");
    parts.retain(`draft ${first} ${second}`);
    const changed = parts.current;

    assert.deepEqual(
      rendered.map((part) => part.marker),
      [first],
    );
    assert.equal(
      changed.length === rendered.length &&
        changed.every((part, index) => part === rendered[index]),
      false,
      "tag refresh must rebuild after a part is added",
    );

    const unchanged = parts.current;
    assert.equal(
      unchanged.length === changed.length &&
        unchanged.every((part, index) => part === changed[index]),
      true,
      "tag refresh must still skip unchanged parts",
    );
  });

  void test("keeps compact tags in the textarea and typed parts at submission", async () => {
    const parts = new ComposerParts();
    const file = parts.addFile("/tmp/a file.ts");
    const image = parts.addImage({
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
    const prepared = await parts.prepare(`look at ${file} ${image}`, 42);

    assert.equal(prepared.displayText, "look at [File a file.ts] [Image 1]");
    assert.deepEqual(prepared.message, {
      role: "user",
      content: [
        { type: "text", text: "look at @file:///tmp/a%20file.ts " },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      timestamp: 42,
    });
    assert.equal(parts.load(prepared.message.content), "look at [File a file.ts] [Image 1]");
  });

  // Editing a sent message reloads it into the composer, so a second send has
  // to reproduce the message byte for byte: the inlined file body must come
  // back from the message instead of a fresh read, and the image bytes must
  // survive the trip through the marker.
  void test("an edited message reloads its attachments and re-sends unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-edit-"));
    try {
      const path = join(directory, "notes.ts");
      await writeFile(path, "const answer = 42;");
      const parts = new ComposerParts();
      const draft = `look at ${parts.addFile(path)} ${parts.addImage({
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      })}`;
      const sent = await parts.prepare(draft, 42);
      const sentContent = sent.message.content;
      if (typeof sentContent === "string") throw new Error("expected rich message content");
      const head = sentContent[0];
      if (head?.type !== "text") throw new Error("expected a leading text part");
      assert.match(head.text, /<file src="file:\/\/.*notes\.ts">\nconst answer = 42;\n<\/file>/);

      const edited = new ComposerParts();
      const reloaded = edited.load(sent.message.content);
      assert.equal(reloaded, "look at [File notes.ts] [Image 1]");

      // The body on disk changes under the composer; the reload keeps what the
      // chat actually said.
      await writeFile(path, "const answer = 43;");
      const resent = await edited.prepare(reloaded, 42);
      assert.deepEqual(resent.message, sent.message);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("keeps image markers local and renumbers retained images", async () => {
    const parts = new ComposerParts();
    const first = parts.addImage({ type: "image", data: "Zmlyc3Q=", mimeType: "image/png" });
    const second = parts.addImage({ type: "image", data: "c2Vjb25k", mimeType: "image/png" });
    const prepared = await parts.prepare(`keep ${second}`);

    assert.equal(first, "[Image 1]");
    assert.equal(prepared.displayText, "keep [Image 1]");
    assert.deepEqual(prepared.message.content, [
      { type: "text", text: "keep " },
      { type: "image", data: "c2Vjb25k", mimeType: "image/png" },
    ]);
    assert.equal(parts.load(prepared.message.content), "keep [Image 1]");
  });

  void test("parks a tall paste behind a marker and submits every line", async () => {
    const parts = new ComposerParts();
    const pasted = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join("\n");
    const marker = parts.addPaste(pasted);
    assert.equal(marker, "[Paste #1 12 lines]");

    const prepared = await parts.prepare(`explain ${marker}`, 7);
    assert.equal(prepared.displayText, "explain [Paste #1 12 lines]");
    assert.equal(prepared.message.content, `explain ${pasted}`);

    // A marker deleted from the draft takes its lines with it.
    parts.retain("explain");
    assert.equal((await parts.prepare("explain nothing")).message.content, "explain nothing");
  });

  void test("re-reads a file after its marker leaves the draft", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-composer-"));
    const path = join(directory, "changing.txt");
    try {
      const parts = new ComposerParts();
      await writeFile(path, "first body");
      const firstMarker = parts.addFile(path);
      assert.match(String((await parts.prepare(firstMarker)).message.content), /first body/);

      parts.retain("");
      await writeFile(path, "second body");
      const secondMarker = parts.addFile(path);
      const second = String((await parts.prepare(secondMarker)).message.content);
      assert.match(second, /second body/);
      assert.doesNotMatch(second, /first body/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("folds attachment bodies back to tags for one-line labels", () => {
    const sent = `look at ${fileAttachmentBlock("/tmp/notes.ts", "const answer = 42;")} and @file:///tmp/other.ts`;
    assert.equal(foldAttachments(sent), "look at [File notes.ts] and [File other.ts]");
  });

  void test("classifies multiline text, files, and images at the paste boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-composer-"));
    try {
      const textPath = join(directory, "notes.txt");
      const imagePath = join(directory, "pixel.png");
      await writeFile(textPath, "notes");
      await writeFile(
        imagePath,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggWDxgWQ5q78wAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yMlQxNToyNDoyMiswMDowMCBNydkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjJUMTU6MjQ6MjIrMDA6MDBREHFlAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTIyVDE1OjI0OjIyKzAwOjAwBgVQugAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
          "base64",
        ),
      );

      assert.deepEqual(await resolveComposerPaste("one\r\ntwo", directory), {
        kind: "text",
        text: "one\ntwo",
      });
      assert.deepEqual(await resolveComposerPaste(textPath, directory), {
        kind: "file",
        path: textPath,
      });
      assert.deepEqual(await resolveComposerPaste(directory, directory), {
        kind: "text",
        text: directory,
      });
      const image = await resolveComposerPaste(imagePath, directory);
      assert.equal(image.kind, "image");
      if (image.kind === "image") {
        assert.equal(image.image.mimeType, "image/png");
      }
      const binary = resolveComposerImagePaste(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggWDxgWQ5q78wAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yMlQxNToyNDoyMiswMDowMCBNydkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjJUMTU6MjQ6MjIrMDA6MDBREHFlAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTIyVDE1OjI0OjIyKzAwOjAwBgVQugAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      assert.equal(binary?.image.mimeType, "image/png");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("discovers mentionable files without walking dependency trees", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-mentions-"));
    try {
      await mkdir(join(directory, "src"));
      await mkdir(join(directory, "node_modules"));
      await writeFile(join(directory, "README.md"), "readme");
      await writeFile(join(directory, "src", "index.ts"), "export {};");
      await writeFile(join(directory, "node_modules", "ignored.js"), "");
      const files = await discoverMentionFiles(directory);
      assert.deepEqual(
        files.map((file) => file.displayPath),
        ["README.md", "src/index.ts"],
      );
      assert.deepEqual(fileMentionQuery("inspect @src/in"), {
        start: 8,
        query: "src/in",
      });
      assert.equal(fileMentionSuggestions("inspect @index", files)?.files[0]?.label, "index.ts");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

void describe("prompt history", () => {
  void test("browses back from any draft and restores it after the newest entry", () => {
    const history = new PromptHistory();
    history.replace(["first", "second"]);
    assert.equal(history.previous("draft"), "second");
    assert.equal(history.previous("second"), "first");
    assert.equal(history.previous("first"), undefined);
    assert.equal(history.next(), "second");
    assert.equal(history.next(), "draft");
    assert.equal(history.next(), undefined);
    assert.equal(history.previous(""), "second");
    assert.equal(history.next(), "");
  });

  void test("deduplicates adjacent submissions", () => {
    const history = new PromptHistory();
    history.record("same");
    history.record("same");
    assert.equal(history.previous(""), "same");
    assert.equal(history.previous("same"), undefined);
  });
});
