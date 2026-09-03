/**
 * One test per HookRegistry combining rule and per failure row in plugins.md §6.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentMessage } from "../src/types.ts";
import { type HookHandler, type HookName, HookRegistry } from "../src/harness/hooks.ts";

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
  void test("transform_context chains messages and system prompt", async () => {
    const { hooks } = registry();
    hooks.on("transform_context", (event) => ({ messages: [...event.messages, user("x")] }));
    hooks.on("transform_context", (event) => ({ systemPrompt: `${event.systemPrompt}!` }));
    const result = await hooks.run("transform_context", {
      ...base,
      messages: [user("p")],
      systemPrompt: "sys",
    });
    assert.equal(result?.messages?.length, 2);
    assert.equal(result?.systemPrompt, "sys!");
  });

  void test("before_request applies patches in order and returns a net patch", async () => {
    const { hooks } = registry();
    hooks.on("before_request", () => ({
      streamOptions: { headers: { a: "1" }, temperature: 0.5 },
    }));
    hooks.on("before_request", () => ({ streamOptions: { headers: { a: undefined, b: "2" } } }));
    const result = await hooks.run("before_request", {
      ...base,
      model: { provider: "p", modelId: "m" },
      step: "assistant",
      attempt: 1,
      streamOptions: { headers: { keep: "k" } },
    });
    assert.deepEqual(result?.streamOptions, { temperature: 0.5, headers: { b: "2" } });
  });

  void test("before_tool: modifications chain, first rejection wins", async () => {
    const { hooks } = registry();
    let fourth = 0;
    hooks.on("before_tool", (event) => ({
      action: "modify",
      args: { ...event.args, a: 1 },
    }));
    hooks.on("before_tool", (event) => ({
      action: "modify",
      args: { ...event.args, b: 2 },
    }));
    hooks.on("before_tool", (event) => {
      assert.deepEqual(event.args, { cmd: "ls", a: 1, b: 2 });
      return { action: "reject", message: "stop" };
    });
    hooks.on("before_tool", () => {
      fourth += 1;
      return { action: "continue" };
    });
    const result = await hooks.run("before_tool", {
      ...base,
      toolCallId: "c1",
      toolName: "bash",
      args: { cmd: "ls" },
    });
    assert.deepEqual(result, { action: "reject", message: "stop" });
    assert.equal(fourth, 0);
  });

  void test("before_tool: continue is not terminal; a later policy still rejects", async () => {
    const { hooks } = registry();
    hooks.on("before_tool", () => ({ action: "continue" }));
    hooks.on("before_tool", () => ({ action: "reject", message: "later says no" }));
    const result = await hooks.run("before_tool", {
      ...base,
      toolCallId: "c1",
      toolName: "bash",
      args: { cmd: "ls" },
    });
    assert.deepEqual(result, { action: "reject", message: "later says no" });
  });

  void test("before_tool: a malformed decision from an untyped handler fails closed as error", async () => {
    const { hooks, reported } = registry();
    let later = 0;
    // Registrations are type-erased, so a JavaScript plugin can return anything.
    const untyped: unknown = () => ({ action: "bogus" });
    hooks.on("before_tool", untyped as HookHandler<"before_tool">, { id: "legacy" });
    hooks.on("before_tool", () => {
      later += 1;
      return { action: "continue" };
    });
    const result = await hooks.run("before_tool", {
      ...base,
      toolCallId: "c1",
      toolName: "bash",
      args: {},
    });
    assert.equal(result.action, "error");
    if (result.action === "error") assert.match(result.message, /legacy.*malformed.*bash.*"bogus"/);
    assert.equal(later, 0);
    assert.equal(reported[0]?.hook, "before_tool");
  });

  void test("before_tool: modify args that are not durable JSON fail closed as error", async () => {
    const { hooks, reported } = registry();
    let later = 0;
    const untyped: unknown = () => ({ action: "modify", args: { when: new Date(0), n: Infinity } });
    hooks.on("before_tool", untyped as HookHandler<"before_tool">, { id: "legacy" });
    hooks.on("before_tool", () => {
      later += 1;
      return { action: "continue" };
    });
    const result = await hooks.run("before_tool", {
      ...base,
      toolCallId: "c1",
      toolName: "bash",
      args: { cmd: "ls" },
    });
    assert.equal(result.action, "error");
    if (result.action === "error") assert.match(result.message, /legacy.*not durable JSON/);
    assert.equal(later, 0);
    assert.equal(reported[0]?.hook, "before_tool");
  });

  void test("before_tool: a throwing policy fails closed as error", async () => {
    const { hooks, reported } = registry();
    hooks.on("before_tool", () => {
      throw new Error("policy failed");
    });
    const result = await hooks.run("before_tool", {
      ...base,
      toolCallId: "c1",
      toolName: "bash",
      args: {},
    });
    assert.deepEqual(result, { action: "error", message: "policy failed" });
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
    const result = await hooks.run("after_tool", {
      ...base,
      toolCallId: "c1",
      toolName: "bash",
      args: {},
      content: [],
      details: null,
      isError: false,
    });
    assert.deepEqual(result, {
      content: [{ type: "text", text: "0" }],
      isError: true,
      details: { seen: "0" },
    });
    assert.deepEqual(reported, [{ hook: "after_tool", message: "bad" }]);
  });

  void test("any other hook: throw is reported, that result dropped, chain continues", async () => {
    const { hooks, reported } = registry();
    hooks.on("transform_context", () => {
      throw new Error("x");
    });
    hooks.on("transform_context", () => ({ systemPrompt: "ok" }));
    const result = await hooks.run("transform_context", {
      ...base,
      messages: [],
      systemPrompt: "in",
    });
    assert.deepEqual(result, { messages: [], systemPrompt: "ok" });
    assert.equal(reported.length, 1);
  });

  void test("unsubscribe removes one registration; has() reflects it; close refuses new work", async () => {
    const { hooks } = registry();
    const off = hooks.on("transform_context", () => ({ systemPrompt: "changed" }));
    assert.equal(hooks.has("transform_context"), true);
    off();
    assert.equal(hooks.has("transform_context"), false);
    hooks.close(new Error("closed"));
    assert.throws(() => hooks.on("transform_context", () => undefined), /closed/);
    await assert.rejects(
      hooks.run("transform_context", { ...base, messages: [], systemPrompt: "in" }),
      /closed/,
    );
  });
});
