import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolWait, toJsonValue } from "@uji-ai/plugin";
import type { WaitingCall, ToolWakeContext } from "@uji-ai/plugin";
import { answerFor, questionTool } from "../examples/question.ts";

const QUESTION = {
  question: "Which implementation?",
  options: [{ label: "Small patch", description: "Change one owner" }, { label: "Broad rewrite" }],
};

function contextWith(reply?: string): ToolWakeContext {
  return {
    signal: new AbortController().signal,
    aborted: false,
    ...(reply === undefined ? {} : { reply }),
  };
}

function waitingCall(): WaitingCall {
  // Args reach a wake the way production hands them over: as durable JSON.
  return {
    runId: "run-1",
    toolCallId: "call-1",
    resultEntryId: "e-1",
    args: toJsonValue(QUESTION),
  };
}

void test("asking parks the call instead of blocking a process on it", async () => {
  await assert.rejects(
    questionTool.execute("call-1", QUESTION),
    (error: unknown) => error instanceof ToolWait,
  );
});

void test("a reply selects by number or label; anything else is its own answer", () => {
  assert.equal(answerFor(QUESTION, "2"), "Broad rewrite");
  assert.equal(answerFor(QUESTION, "broad rewrite"), "Broad rewrite");
  assert.equal(answerFor(QUESTION, "  Wait for the migration  "), "Wait for the migration");
});

void test("the wake settles from the recorded reply", async () => {
  assert.ok(questionTool.wake);
  const outcome = await questionTool.wake(waitingCall(), contextWith("Broad rewrite"));
  assert.equal(outcome.kind, "settle");
  if (outcome.kind === "settle") {
    assert.deepEqual(outcome.result.content, [{ type: "text", text: "Broad rewrite" }]);
    assert.deepEqual(outcome.result.details, {
      question: "Which implementation?",
      answer: "Broad rewrite",
    });
  }
});

void test("no reply keeps waiting", async () => {
  assert.ok(questionTool.wake);
  assert.deepEqual(await questionTool.wake(waitingCall(), contextWith()), { kind: "wait" });
});

void test("walking away is not an answer", async () => {
  assert.ok(questionTool.wake);
  const outcome = await questionTool.wake(waitingCall(), contextWith("   "));
  assert.equal(outcome.kind === "settle" && outcome.isError, true);
  if (outcome.kind === "settle") {
    assert.match(
      outcome.result.content[0]?.type === "text" ? outcome.result.content[0].text : "",
      /unanswered/,
    );
  }
});
