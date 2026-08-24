/**
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/ai/test/text.test.ts
 * Synced with pi 7ebf9087e.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@uji-ai/schema";
import { contentText } from "../src/utils/text.ts";

const content: AssistantMessage["content"] = [
  { type: "thinking", thinking: "reasoning" },
  { type: "text", text: "first" },
  { type: "toolCall", id: "1", name: "read", arguments: {} },
  { type: "text", text: "second" },
];

void describe("contentText", () => {
  void test("extracts assistant text blocks", () => {
    assert.equal(contentText(content), "first\nsecond");
  });

  void test("supports custom separators", () => {
    assert.equal(contentText(content, ""), "firstsecond");
  });

  void test("passes string content through", () => {
    assert.equal(contentText("hello"), "hello");
  });

  void test("extracts text from tool-result content", () => {
    const toolResultContent: ToolResultMessage["content"] = [
      { type: "text", text: "first" },
      { type: "image", data: "...", mimeType: "image/png" },
      { type: "text", text: "second" },
    ];

    assert.equal(contentText(toolResultContent, ""), "firstsecond");
  });
});
