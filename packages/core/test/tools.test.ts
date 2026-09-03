import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createLocalBashOperations } from "../src/tools/bash.ts";
import { createEditTool } from "../src/tools/edit.ts";
import { createAllTools } from "../src/tools/index.ts";
import { createLsTool } from "../src/tools/ls.ts";
import { createWriteTool } from "../src/tools/write.ts";
import { toolResultText } from "../src/utils/tool-result.ts";

void describe("createAllTools", () => {
  void test("composes exactly the five coding tools, in order", () => {
    const names = createAllTools("/tmp").map((tool) => tool.name);
    assert.deepEqual(names, ["read", "bash", "edit", "write", "ls"]);
  });
});

void describe("ls tool", () => {
  void test("sorts entries and marks directories", async () => {
    const tool = createLsTool("/workspace", {
      operations: {
        exists: () => true,
        stat: (path) => ({ isDirectory: () => path !== "/workspace/z.txt" }),
        readdir: () => ["z.txt", "folder"],
      },
    });

    const result = await tool.execute("call_1", {});
    assert.equal(toolResultText(result.content), "folder/\nz.txt");
  });

  void test("observes aborts while an operation is in flight", async () => {
    let finishRead: ((entries: string[]) => void) | undefined;
    const entries = new Promise<string[]>((resolve) => {
      finishRead = resolve;
    });
    const tool = createLsTool("/workspace", {
      operations: {
        exists: () => true,
        stat: () => ({ isDirectory: () => true }),
        readdir: () => entries,
      },
    });
    const controller = new AbortController();

    const execution = tool.execute("call_1", {}, controller.signal);
    controller.abort();
    finishRead?.([]);

    await assert.rejects(execution, /Operation aborted/);
  });
});

void describe("file mutation tools", () => {
  void test("write returns a patch for creates and overwrites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-write-tool-"));
    const path = "nested/example.ts";
    const absolutePath = join(directory, path);
    const tool = createWriteTool(directory);

    try {
      const created = await tool.execute("call_1", { path, content: "first\nkept\n" });
      assert.equal(toolResultText(created.content), `Wrote ${path}.`);
      assert.match(created.details.patch, /@@ -0,0 \+1,2 @@/u);
      assert.match(created.details.diff, /\+1 first\n\+2 kept/u);
      assert.equal(created.details.firstChangedLine, 1);

      const updated = await tool.execute("call_2", { path, content: "changed\nkept\n" });
      assert.match(updated.details.patch, /-first\n\+changed/u);
      assert.match(updated.details.diff, /-1 first\n\+1 changed/u);
      assert.equal(await readFile(absolutePath, "utf8"), "changed\nkept\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void test("edit returns the shared patch details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uji-edit-tool-"));
    const path = "example.ts";

    try {
      await writeFile(join(directory, path), "before\nkept\n");
      const result = await createEditTool(directory).execute("call_1", {
        path,
        edits: [{ oldText: "before", newText: "after" }],
      });
      assert.equal(toolResultText(result.content), `Replaced 1 block(s) in ${path}.`);
      assert.match(result.details.patch, /-before\n\+after/u);
      assert.match(result.details.diff, /-1 before\n\+1 after/u);
      assert.equal(result.details.firstChangedLine, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

void describe("local bash lifecycle", () => {
  void test(
    "abort kills the active shell process group",
    { skip: process.platform === "win32" },
    async () => {
      const operations = createLocalBashOperations();
      const controller = new AbortController();
      let resolvePid: ((pid: number) => void) | undefined;
      const childPid = new Promise<number>((resolve) => {
        resolvePid = resolve;
      });
      let output = "";
      const execution = operations.exec("sleep 30 & child=$!; echo $child; wait $child", "/tmp", {
        signal: controller.signal,
        onData: (chunk) => {
          output += chunk.toString("utf8");
          const pid = Number.parseInt(output.trim(), 10);
          if (Number.isSafeInteger(pid) && pid > 0) resolvePid?.(pid);
        },
      });
      const pid = await childPid;

      controller.abort();
      await assert.rejects(execution, /aborted/);
      let alive = true;
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false);
    },
  );
});
