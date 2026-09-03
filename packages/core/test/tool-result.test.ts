/**
 * Invariant 31: a settled tool result is self-contained. A failed or aborted
 * tool keeps the last partial its `onUpdate` reported, a `ToolError` stays the
 * tool's own decision, and the `tool_progress` overlay previews the same
 * `details` field the settlement writes.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toolProgress } from "../src/harness/runner.ts";
import { ToolError, toolErrorResult } from "../src/utils/tool-result.ts";

void describe("toolErrorResult with a last partial", () => {
  void test("keeps partial content, details, and title the error left blank", () => {
    const result = toolErrorResult(new Error("aborted"), {
      content: [{ type: "text", text: "partial stdout" }],
      details: { patch: "--- a/view.md\n+++ b/view.md" },
      title: "view.md",
    });

    assert.deepEqual(result, {
      content: [
        { type: "text", text: "aborted" },
        { type: "text", text: "partial stdout" },
      ],
      details: { patch: "--- a/view.md\n+++ b/view.md" },
      title: "view.md",
    });
  });

  void test("never overrides details or title the error already settled", () => {
    const structured = new ToolError({
      content: [{ type: "text", text: "exit 1" }],
      details: { code: 1 },
      title: "make",
    });

    assert.deepEqual(toolErrorResult(structured, { details: { patch: "x" }, title: "other" }), {
      content: [{ type: "text", text: "exit 1" }],
      details: { code: 1 },
      title: "make",
    });
  });

  void test("drops partial shapes it cannot trust", () => {
    assert.deepEqual(toolErrorResult(new Error("boom"), "not an object"), {
      content: [{ type: "text", text: "boom" }],
      details: {},
    });
    assert.deepEqual(
      toolErrorResult(new Error("boom"), { content: [{ type: "text" }, 42], title: 7 }),
      { content: [{ type: "text", text: "boom" }], details: {} },
    );
  });
});

void describe("tool_progress overlay", () => {
  const update = (partialResult: unknown) => toolProgress(partialResult);

  void test("passes the partial's details through beside text and title", () => {
    assert.deepEqual(
      update({
        content: [{ type: "text", text: "searching" }],
        title: "uji",
        details: { provider: "exa", results: [] },
      }),
      { text: "searching", title: "uji", details: { provider: "exa", results: [] } },
    );
  });

  void test("drops details that do not round-trip through JSON", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    assert.deepEqual(update({ content: [], details: circular }), { text: "" });
  });
});
