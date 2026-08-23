import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  directoryCompletionQuery,
  discoverDirectorySuggestions,
} from "../src/directory-autocomplete.ts";

void test("parses the directory fragment at the end of /cd", () => {
  assert.deepEqual(directoryCompletionQuery("/cd ../"), { parent: "../", prefix: "" });
  assert.deepEqual(directoryCompletionQuery("/cd ../co"), { parent: "../", prefix: "co" });
  assert.deepEqual(directoryCompletionQuery("/cd packages/tui"), {
    parent: "packages/",
    prefix: "tui",
  });
  assert.deepEqual(directoryCompletionQuery("/cd ~"), { parent: "~/", prefix: "" });
  assert.equal(directoryCompletionQuery("/model gpt"), undefined);
});

void test("discovers matching child directories for relative cd paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "uji-directory-completion-"));
  const packages = join(root, "packages");
  const cwd = join(packages, "tui");
  try {
    await mkdir(join(packages, "core"), { recursive: true });
    await mkdir(cwd);
    await mkdir(join(packages, ".hidden"));
    await writeFile(join(packages, "README.md"), "not a directory");
    await symlink(join(packages, "core"), join(packages, "linked-core"));

    const query = directoryCompletionQuery("/cd ../");
    assert.ok(query !== undefined);
    const suggestions = await discoverDirectorySuggestions(cwd, query);
    assert.deepEqual(
      suggestions.map((suggestion) => suggestion.completion),
      ["../core/", "../linked-core/", "../tui/"],
    );

    const filteredQuery = directoryCompletionQuery("/cd ../co");
    assert.ok(filteredQuery !== undefined);
    assert.deepEqual(await discoverDirectorySuggestions(cwd, filteredQuery), [
      { completion: "../core/" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
