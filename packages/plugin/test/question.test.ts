import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskRequest } from "@uji-ai/plugin";
import { createQuestionTool } from "../examples/question.ts";

void test("question plugin turns a client selection into a tool result", async () => {
  let request: AskRequest | undefined;
  const tool = createQuestionTool((next) => {
    request = next;
    return Promise.resolve("1");
  });

  const result = await tool.execute("call-1", {
    question: "Which implementation?",
    options: [
      { label: "Small patch", description: "Change one owner" },
      { label: "Broad rewrite" },
    ],
  });

  assert.deepEqual(request, {
    kind: "select",
    title: "Which implementation?",
    options: [
      { value: "0", label: "Small patch", description: "Change one owner" },
      { value: "1", label: "Broad rewrite", description: undefined },
    ],
  });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "Broad rewrite" }],
    details: { question: "Which implementation?", answer: "Broad rewrite" },
  });
});

void test("question plugin rejects an answer that was not offered", async () => {
  const tool = createQuestionTool(() => Promise.resolve("9"));

  await assert.rejects(
    tool.execute("call-1", {
      question: "Continue?",
      options: [{ label: "Yes" }, { label: "No" }],
    }),
    /unknown choice/,
  );
});
