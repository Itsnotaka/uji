/**
 * A run driven through `harness.hooks`. `before_tool` policies decide and
 * clear args ahead of the `tool_started` commit, `after_tool` patches the result,
 * `transform_context` rewrites the model context, and a failing hook or
 * listener becomes a `diagnostic` event instead of a failed run.
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
import { HookRegistry } from "../src/harness/hooks.ts";
import { step } from "../src/harness/runner.ts";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import type { SessionStorage } from "../src/harness/session/types.ts";
import type { EphemeralEvent } from "../src/sdk/types.ts";
import {
  definePlugin,
  inlinePlugin,
  systemPromptPlugin,
  type HarnessTool,
  type Plugin,
} from "../src/plugins/index.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import { prompt } from "./harness-driver.ts";

/** A plugin that contributes a fixed list of tools. */
function toolsPlugin(tools: readonly HarnessTool[]): Plugin {
  return definePlugin({
    id: "tools",
    session(api) {
      api.tools.add((draft) => {
        for (const tool of tools) draft.set(tool.name, tool);
      });
    },
  });
}

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

/** First turn calls `echo` twice, second turn stops. */
function twoToolsThenStop(): StreamFn {
  let turn = 0;
  return () => {
    turn += 1;
    if (turn === 1) {
      return stream(
        assistant(
          [
            { type: "toolCall", id: "call_1", name: "echo", arguments: { text: "one" } },
            { type: "toolCall", id: "call_2", name: "echo", arguments: { text: "two" } },
          ],
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
    description: "echo text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params, _signal, onUpdate) => {
      if (!isEchoParams(params)) throw new Error("echo: invalid params");
      onUpdate?.({ content: [{ type: "text", text: "echoing" }], details: {} });
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
  const harness = await AgentHarness.create({
    session,
    streamFn,
    plugins: [inlinePlugin(systemPromptPlugin("sys")), inlinePlugin(toolsPlugin(tools))],
    env: { cwd: "/" },
    model,
  });
  harness.attach();
  const events: EphemeralEvent[] = [];
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

async function toolResultTexts(session: SessionStorage): Promise<string[]> {
  const texts: string[] = [];
  for (const entry of await session.getBranch("main")) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const part = entry.message.content[0];
      if (part?.type === "text") texts.push(part.text);
    }
  }
  return texts;
}

async function toolResultText(session: SessionStorage): Promise<string | undefined> {
  return (await toolResultTexts(session))[0];
}

void describe("AgentHarness hooks", () => {
  void test("before_tool rejection: no effect or intent, model sees the reason", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", (event) =>
      event.toolName === "echo"
        ? { action: "reject", message: "echo is off" }
        : { action: "continue" },
    );
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "completed");
    assert.deepEqual(calls, []);
    assert.equal(await toolResultText(h.session), "echo is off");
    assert.deepEqual(await h.session.findRecords({ type: "tool_started" }), []);
    await h.close();
  });

  void test("before_tool error: the call settles without its effect and the run fails as policy", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", () => ({ action: "error", message: "policy unavailable" }));
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "failed");
    if (result.outcome.kind === "failed") {
      assert.deepEqual(result.outcome.error, { code: "policy", message: "policy unavailable" });
    }
    assert.deepEqual(calls, []);
    assert.equal(await toolResultText(h.session), "policy unavailable");
    assert.deepEqual(await h.session.findRecords({ type: "tool_started" }), []);
    await h.close();
  });

  void test("a policy failure keeps its code when the finished run is read back from the log", async () => {
    const h = await open(toolThenStop(), [echoTool([])]);
    h.harness.hooks.on("before_tool", () => ({ action: "error", message: "policy unavailable" }));
    const result = await prompt(h.harness, "go");
    // A later reader, another host or a resumed step, sees the record, not the live outcome.
    const state = await h.session.runState(result.runId);
    assert.equal(state.kind, "finished");
    if (state.kind === "finished") {
      assert.deepEqual(state.finished.error, { code: "policy", message: "policy unavailable" });
    }
    const reread = await step({
      session: h.session,
      runId: result.runId,
      hooks: new HookRegistry(() => undefined),
      streamFn: toolThenStop(),
      tools: [],
      model,
      systemPrompt: "sys",
      emit: async () => undefined,
    });
    assert.equal(reread.kind, "finished");
    if (reread.kind === "finished" && reread.operation === "run") {
      assert.equal(reread.outcome.kind, "failed");
      if (reread.outcome.kind === "failed") {
        assert.deepEqual(reread.outcome.error, { code: "policy", message: "policy unavailable" });
      }
    }
    await h.close();
  });

  void test("before_tool: a throwing policy fails closed and the run fails as policy", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", () => {
      throw new Error("policy crashed");
    });
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "failed");
    if (result.outcome.kind === "failed") {
      assert.deepEqual(result.outcome.error, { code: "policy", message: "policy crashed" });
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await h.session.findRecords({ type: "tool_started" }), []);
    await h.close();
  });

  void test("before_tool error: later calls in the batch never start their effect", async () => {
    const calls: unknown[] = [];
    const policed: string[] = [];
    const h = await open(twoToolsThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", (event) => {
      policed.push(event.toolCallId);
      return event.toolCallId === "call_1"
        ? { action: "error", message: "policy unavailable" }
        : { action: "continue" };
    });
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "failed");
    if (result.outcome.kind === "failed") assert.equal(result.outcome.error.code, "policy");
    // The second call was neither policed nor run, yet it still settled for the model.
    assert.deepEqual(policed, ["call_1"]);
    assert.deepEqual(calls, []);
    assert.deepEqual(await toolResultTexts(h.session), ["policy unavailable", "policy unavailable"]);
    assert.deepEqual(await h.session.findRecords({ type: "tool_started" }), []);
    await h.close();
  });

  void test("before_tool: continue does not bypass a later policy's rejection", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", () => ({ action: "continue" }));
    h.harness.hooks.on("before_tool", () => ({ action: "reject", message: "second says no" }));
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "completed");
    assert.deepEqual(calls, []);
    assert.equal(await toolResultText(h.session), "second says no");
    await h.close();
  });

  void test("before_tool args rewrite: tool runs with cleared args and the ledger stores them", async () => {
    const calls: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", (event) => ({
      action: "modify",
      args: { ...event.args, text: "rewritten" },
    }));
    await prompt(h.harness, "go");
    assert.deepEqual(calls, [{ text: "rewritten" }]);
    const started = await h.session.findRecords({ type: "tool_started" });
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.type === "tool_started" ? started[0].effectiveArgs : undefined, {
      text: "rewritten",
    });
    assert.equal(await toolResultText(h.session), "echo:rewritten");
    await h.close();
  });

  void test("after_tool sees the arguments the effect received, not the model's proposal", async () => {
    const calls: unknown[] = [];
    const observed: unknown[] = [];
    const h = await open(toolThenStop(), [echoTool(calls)]);
    h.harness.hooks.on("before_tool", (event) => ({
      action: "modify",
      args: { ...event.args, text: "rewritten" },
    }));
    h.harness.hooks.on("after_tool", (event) => {
      observed.push(event.args);
      return undefined;
    });
    await prompt(h.harness, "go");
    assert.deepEqual(calls, [{ text: "rewritten" }]);
    assert.deepEqual(observed, [{ text: "rewritten" }]);
    await h.close();
  });

  void test("after_tool patches the result the model receives", async () => {
    const calls: unknown[] = [];
    const seen: Message[][] = [];
    const h = await open(toolThenStop(seen), [echoTool(calls)]);
    h.harness.hooks.on("after_tool", (event) => ({
      content: [{ type: "text", text: `[redacted ${event.toolName}]` }],
    }));
    await prompt(h.harness, "go");
    assert.equal(await toolResultText(h.session), "[redacted echo]");
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
    await prompt(h.harness, "go");
    assert.equal(seen[0]?.[0]?.content, "injected");
    assert.equal(seen[1]?.[0]?.content, "injected");
    const branch = await h.session.getBranch("main");
    assert.equal(
      branch.some((entry) => entry.type === "message" && entry.message.content === "injected"),
      false,
    );
    await h.close();
  });

  void test("a throwing after_tool hook is reported as a diagnostic and the run completes", async () => {
    const h = await open(toolThenStop(), [echoTool([])]);
    h.harness.hooks.on("after_tool", () => {
      throw new Error("hook broke");
    });
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "completed");
    const errors = h.events.filter((event) => event.kind === "diagnostic");
    assert.equal(errors.length, 1);
    assert.deepEqual(
      errors[0]?.kind === "diagnostic" ? { owner: errors[0].owner, message: errors[0].message } : undefined,
      { owner: "hook after_tool", message: "hook broke" },
    );
    assert.equal(await toolResultText(h.session), "echo:hi");
    await h.close();
  });

  void test("a throwing listener is isolated: a diagnostic is emitted and the run completes", async () => {
    const h = await open(toolThenStop(), [echoTool([])]);
    h.harness.subscribe((event) => {
      if (event.kind === "tool_progress") throw new Error("listener broke");
    });
    const result = await prompt(h.harness, "go");
    assert.equal(result.outcome.kind, "completed");
    const errors = h.events.filter((event) => event.kind === "diagnostic");
    assert.ok(errors.length >= 1);
    assert.equal(
      errors[0]?.kind === "diagnostic" ? errors[0].owner : "",
      "listener tool_progress",
    );
    await h.close();
  });
});
