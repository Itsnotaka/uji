import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLsTool } from "../src/tools/ls.ts";
import { toolResultText } from "../src/utils/tool-result.ts";

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
