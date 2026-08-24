/**
 * One test per HookRegistry combining rule and per failure row in plugins.md §6.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentMessage } from "../src/types.ts";
import { BACKGROUND_CONTEXT } from "../src/harness/context.ts";
import { type HookName, HookRegistry } from "../src/harness/hooks.ts";

const ctx = BACKGROUND_CONTEXT;
const base = { head: "main", runId: "run_1" };

function registry() {
  const reported: { hook: HookName; message: string }[] = [];
  const hooks = new HookRegistry((error, hook) => {
    reported.push({ hook, message: error.message });
  });
  return { hooks, reported };
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

void describe("HookRegistry", () => {
  void test("before_run chains injected messages and later handlers see earlier injections", async () => {
    const { hooks } = registry();
    hooks.on("before_run", () => ({ messages: [user("a")] }));
    hooks.on("before_run", (event) => ({ messages: [user(`saw ${event.prompt.length}`)] }));
    const result = await hooks.run(
      "before_run",
      { ...base, prompt: [user("p")], resources: {} },
      ctx,
    );
    assert.deepEqual(
      result?.messages?.map((m) => m.content),
      ["a", "saw 2"],
    );
  });

  void test("before_drive is fail-closed: a throw refuses the drive and is reported", async () => {
    const { hooks, reported } = registry();
    hooks.on("before_drive", () => {
      throw new Error("nope");
    });
    await assert.rejects(hooks.run("before_drive", { ...base, operation: "run" }, ctx), /nope/);
    assert.deepEqual(reported, [{ hook: "before_drive", message: "nope" }]);
  });

  void test("before_run_end: last writer wins", async () => {
    const { hooks } = registry();
    hooks.on("before_run_end", () => ({ followUp: "first" }));
    hooks.on("before_run_end", () => undefined);
    hooks.on("before_run_end", () => ({ followUp: "last" }));
    const result = await hooks.run("before_run_end", { ...base, messages: [] }, ctx);
    assert.deepEqual(result, { followUp: "last" });
  });

  void test("transform_context chains messages and system prompt", async () => {
    const { hooks } = registry();
    hooks.on("transform_context", (event) => ({ messages: [...event.messages, user("x")] }));
    hooks.on("transform_context", (event) => ({ systemPrompt: `${event.systemPrompt}!` }));
    const result = await hooks.run(
      "transform_context",
      { ...base, messages: [user("p")], systemPrompt: "sys" },
      ctx,
    );
    assert.equal(result?.messages?.length, 2);
    assert.equal(result?.systemPrompt, "sys!");
  });

  void test("before_request applies patches in order and returns a net patch", async () => {
    const { hooks } = registry();
    hooks.on("before_request", () => ({
      streamOptions: { headers: { a: "1" }, temperature: 0.5 },
    }));
    hooks.on("before_request", () => ({ streamOptions: { headers: { a: undefined, b: "2" } } }));
    const result = await hooks.run(
      "before_request",
      {
        ...base,
        model: { provider: "p", modelId: "m" },
        step: "assistant",
        attempt: 1,
        streamOptions: { headers: { keep: "k" } },
      },
      ctx,
    );
    assert.deepEqual(result?.streamOptions, { temperature: 0.5, headers: { b: "2" } });
  });

  void test("before_tool: args chain, first block wins, later handlers do not run", async () => {
    const { hooks } = registry();
    let third = 0;
    hooks.on("before_tool", (event) => ({ args: { ...event.args, a: 1 } }));
    hooks.on("before_tool", (event) => ({
      args: { ...event.args, b: 2 },
      block: { reason: "stop", terminate: true },
    }));
    hooks.on("before_tool", () => {
      third += 1;
      return undefined;
    });
    const result = await hooks.run(
      "before_tool",
      { ...base, toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } },
      ctx,
    );
    assert.deepEqual(result, {
      args: { cmd: "ls", a: 1, b: 2 },
      block: { reason: "stop", terminate: true },
    });
    assert.equal(third, 0);
  });

  void test("before_tool: a throwing handler blocks with its message (fail-closed)", async () => {
    const { hooks, reported } = registry();
    hooks.on("before_tool", () => {
      throw new Error("policy says no");
    });
    const result = await hooks.run(
      "before_tool",
      { ...base, toolCallId: "c1", toolName: "bash", args: {} },
      ctx,
    );
    assert.deepEqual(result, { block: { reason: "policy says no" } });
    assert.equal(reported[0]?.hook, "before_tool");
  });

  void test("after_tool: field-wise chained patch; a throwing handler is dropped and reported", async () => {
    const { hooks, reported } = registry();
    hooks.on("after_tool", (event) => ({
      content: [{ type: "text", text: `${event.content.length}` }],
    }));
    hooks.on("after_tool", () => {
      throw new Error("bad");
    });
    hooks.on("after_tool", (event) => ({
      isError: true,
      details: { seen: event.content[0]?.type === "text" ? event.content[0].text : null },
    }));
    const result = await hooks.run(
      "after_tool",
      {
        ...base,
        toolCallId: "c1",
        toolName: "bash",
        args: {},
        content: [],
        details: null,
        isError: false,
      },
      ctx,
    );
    assert.deepEqual(result, {
      content: [{ type: "text", text: "0" }],
      isError: true,
      details: { seen: "0" },
    });
    assert.deepEqual(reported, [{ hook: "after_tool", message: "bad" }]);
  });

  void test("any other hook: throw is reported, that result dropped, chain continues", async () => {
    const { hooks, reported } = registry();
    hooks.on("before_payload", () => {
      throw new Error("x");
    });
    hooks.on("before_payload", () => ({ payload: "ok" }));
    const result = await hooks.run(
      "before_payload",
      { ...base, model: { provider: "p", modelId: "m" }, payload: "in" },
      ctx,
    );
    assert.deepEqual(result, { payload: "ok" });
    assert.equal(reported.length, 1);
  });

  void test("unsubscribe removes one registration; has() reflects it; close refuses new work", async () => {
    const { hooks } = registry();
    const off = hooks.on("before_payload", () => ({ payload: "changed" }));
    assert.equal(hooks.has("before_payload"), true);
    off();
    assert.equal(hooks.has("before_payload"), false);
    hooks.close(new Error("closed"));
    assert.throws(() => hooks.on("before_payload", () => undefined), /closed/);
    await assert.rejects(
      hooks.run(
        "before_payload",
        { ...base, model: { provider: "p", modelId: "m" }, payload: 1 },
        ctx,
      ),
      /closed/,
    );
  });
});
