/**
 * A run driven through `harness.hooks`. `before_tool` gates and clears args
 * ahead of the `tool_started` commit, `after_tool` patches the result,
 * `transform_context` rewrites the model context, and a failing hook or
 * listener becomes a `handler_error` event instead of a failed run.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  Model,
  Usage,
} from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import { Type } from "typebox";
import {
  AgentHarness,
  type HarnessEvent,
  type HarnessTool,
  inlinePlugin,
  SqliteSessionRepo,
  systemPromptPlugin,
  toolsPlugin,
} from "../src/index.ts";
import type { StreamFn } from "../src/types.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function stream(message: AssistantMessage): AssistantMessageEventStream {
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("stream ended without a terminal event");
    },
  );
  queueMicrotask(() => {
    if (message.stopReason !== "stop" && message.stopReason !== "toolUse")
      throw new Error("unsupported");
    events.push({ type: "done", reason: message.stopReason, message });
  });
  return events;
}

/** First turn calls `echo`, second turn stops. */
function toolThenStop(seen: Message[][] = []): StreamFn {
  let turn = 0;
  return (_model, context) => {
    seen.push(context.messages);
    turn += 1;
    if (turn === 1) {
      return stream(
        assistant(
          [{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } }],
          "toolUse",
        ),
      );
    }
    return stream(assistant([{ type: "text", text: "done" }], "stop"));
  };
}

function isEchoParams(value: unknown): value is { text: string } {
  return (
    typeof value === "object" && value !== null && "text" in value && typeof value.text === "string"
  );
}

/** `HarnessTool` erases parameter types, so the tool re-checks what the loop already validated. */
function echoTool(calls: unknown[]): HarnessTool {
  return {
    name: "echo",
    label: "Echo",
    description: "echo text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params) => {
      if (!isEchoParams(params)) throw new Error("echo: invalid params");
      calls.push(params);
      return { content: [{ type: "text", text: `echo:${params.text}` }], details: { ok: true } };
    },
  };
}

async function open(streamFn: StreamFn, tools: HarnessTool[]) {
  const directory = mkdtempSync(join(tmpdir(), "uji-harness-hooks-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const { harness } = await AgentHarness.create({
    session,
    streamFn,
    plugins: [inlinePlugin(systemPromptPlugin("sys")), inlinePlugin(toolsPlugin(tools))],
    env: { cwd: "/" },
    model,
  });
  const events: HarnessEvent[] = [];
  harness.subscribe((event) => {
    events.push(event);
  });
  return {
    harness,
    session,
    events,
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

function toolResultText(events: HarnessEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "message_end" && event.message.role === "toolResult") {
      const part = event.message.content[0];
      return part?.type === "text" ? part.text : undefined;
    }
  }
  return undefined;
}

void describe("AgentHarness hooks", () => {
  void test("before_tool block: tool never runs, no tool_started is committed, model sees the reason", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", (event) =>
      event.toolName === "echo" ? { block: { reason: "echo is off" } } : undefined,
    );
    const result = await h.harness.prompt("go");
    assert.equal(result.ok && result.value.kind, "completed");
    assert.deepEqual(calls, []);
    assert.equal(toolResultText(h.events), "echo is off");
    assert.deepEqual(await h.session.findRecords({ type: "tool_started" }), []);
    await h.close();
  });

  void test("before_tool args rewrite: tool runs with cleared args and the ledger stores them", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", (event) => ({ args: { ...event.args, text: "rewritten" } }));
    await h.harness.prompt("go");
    assert.deepEqual(calls, [{ text: "rewritten" }]);
    const started = await h.session.findRecords({ type: "tool_started" });
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.type === "tool_started" ? started[0].effectiveArgs : undefined, {
      text: "rewritten",
    });
    assert.equal(toolResultText(h.events), "echo:rewritten");
    await h.close();
  });

  void test("after_tool patches the result the model receives", async () => {
    const calls: unknown[] = [];
    const seen: Message[][] = [];
    const h = await open(toolThenStop(seen), [echoTool(calls)]);
    h.harness.hooks.on("after_tool", (event) => ({
      content: [{ type: "text", text: `[redacted ${event.toolName}]` }],
    }));
    await h.harness.prompt("go");
    assert.equal(toolResultText(h.events), "[redacted echo]");
    const secondTurn = seen[1]?.at(-1);
    assert.equal(secondTurn?.role, "toolResult");
    assert.equal(
      secondTurn?.role === "toolResult" && secondTurn.content[0]?.type === "text"
        ? secondTurn.content[0].text
        : "",
      "[redacted echo]",
    );
    await h.close();
  });

  void test("transform_context rewrites what the model sees without touching the session", async () => {
    const seen: Message[][] = [];
    const h = await open(toolThenStop(seen), [echoTool([])]);
    h.harness.hooks.on("transform_context", (event) => ({
      messages: [{ role: "user", content: "injected", timestamp: 0 }, ...event.messages],
    }));
    await h.harness.prompt("go");
    assert.equal(seen[0]?.[0]?.content, "injected");
    assert.equal(seen[1]?.[0]?.content, "injected");
    const branch = await h.session.getBranch("main");
    assert.equal(
      branch.some((entry) => entry.type === "message" && entry.message.content === "injected"),
      false,
    );
    await h.close();
  });

  void test("a throwing after_tool hook is reported as handler_error and the run completes", async () => {
    const h = await open(toolThenStop(), [echoTool([])]);
    h.harness.hooks.on("after_tool", () => {
      throw new Error("hook broke");
    });
    const result = await h.harness.prompt("go");
    assert.equal(result.ok && result.value.kind, "completed");
    const errors = h.events.filter((event) => event.type === "handler_error");
    assert.equal(errors.length, 1);
    assert.deepEqual(
      errors[0]?.type === "handler_error"
        ? { kind: errors[0].kind, error: errors[0].error }
        : undefined,
      { kind: "hook", error: "hook broke" },
    );
    assert.equal(toolResultText(h.events), "echo:hi");
    await h.close();
  });

  void test("a throwing listener is isolated: handler_error is emitted and the run completes", async () => {
    const h = await open(toolThenStop(), [echoTool([])]);
    h.harness.subscribe((event) => {
      if (event.type === "turn_start") throw new Error("listener broke");
    });
    const result = await h.harness.prompt("go");
    assert.equal(result.ok && result.value.kind, "completed");
    const errors = h.events.filter((event) => event.type === "handler_error");
    assert.ok(errors.length >= 1);
    assert.equal(
      errors[0]?.type === "handler_error" && errors[0].kind === "event" ? errors[0].event : "",
      "turn_start",
    );
    await h.close();
  });
});
