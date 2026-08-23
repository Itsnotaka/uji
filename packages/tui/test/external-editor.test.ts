import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { editInExternalEditor, resolveExternalEditor } from "../src/external-editor.ts";

void describe("external editor", () => {
  void test("uses the configured command before VISUAL and EDITOR", () => {
    const env = { VISUAL: "helix", EDITOR: "vim" };
    assert.equal(resolveExternalEditor("nvim", env, "linux"), "nvim");
    assert.equal(resolveExternalEditor(undefined, env, "linux"), "helix");
    assert.equal(resolveExternalEditor(undefined, { EDITOR: "vim" }, "linux"), "vim");
    assert.equal(resolveExternalEditor(undefined, {}, "win32"), "notepad");
    assert.equal(resolveExternalEditor(undefined, {}, "linux"), "nano");
  });

  void test("round-trips the draft through the editor process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-external-editor-test-"));
    const editor = join(directory, "editor.sh");
    try {
      await writeFile(editor, '#!/bin/sh\nprintf "edited draft\\n" > "$1"\n');
      await chmod(editor, 0o700);
      assert.deepEqual(await editInExternalEditor("original", editor), {
        status: "completed",
        text: "edited draft",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
