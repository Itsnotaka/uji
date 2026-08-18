/**
 * Conformance checks for June's Responses-wire adaptation of pi's agent loop.
 *
 * Based on https://github.com/earendil-works/pi/blob/main/packages/agent/test/agent-loop.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentLoop, runAgentLoop, runAgentLoopContinue } from "../src/agent-loop.ts";
import type { AgentEvent, AgentTool, AssistantTurn, LlmContext, StreamFn } from "../src/types.ts";
import { toolResultContent, toolResultText } from "../src/utils/tool-result.ts";
import type { ResponseItem } from "@june/schema";

function userMessage(text: string): ResponseItem {
  return { role: "user", content: text };
}

function assistantMessage(text: string): ResponseItem {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function toolCall(callId: string, name: string, args: unknown): ResponseItem {
  return { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) };
}

function parseValueArgument(args: unknown): { value: string } {
  if (typeof args !== "object" || args === null || !("value" in args)) {
    throw new Error("value must be a string");
  }
  const value = (args as { value: unknown }).value;
  if (typeof value !== "string") throw new Error("value must be a string");
  return { value };
}

function scriptedStream(turns: AssistantTurn[], contexts?: LlmContext[]): StreamFn {
  let index = 0;
  return async (context) => {
    contexts?.push(context);
    const turn = turns[index];
    assert.ok(turn, `unexpected provider request ${index + 1}`);
    index += 1;
    return turn;
  };
}

void describe("agent loop Pi conformance", () => {
  void test("exposes Pi's async event stream and final result", async () => {
    const stream = agentLoop(
      [userMessage("hello")],
      { systemPrompt: "", messages: [] },
      {},
      undefined,
      scriptedStream([{ items: [assistantMessage("done")], stopReason: "stop" }]),
    );
    const events: AgentEvent[] = [];
    for await (const event of stream) events.push(event);

    assert.equal(events.at(-1)?.type, "agent_end");
    assert.deepEqual(await stream.result(), [userMessage("hello"), assistantMessage("done")]);
  });

  void test("rejects event iteration and result when the loop rejects", async () => {
    const stream = agentLoop(
      [userMessage("hello")],
      { systemPrompt: "", messages: [] },
      {},
      undefined,
      async () => {
        throw new Error("stream failed outside its contract");
      },
    );

    const iteration = (async () => {
      for await (const _event of stream) {
        // Drain events emitted before the failure.
      }
    })();
    await assert.rejects(iteration, /stream failed outside its contract/);
    await assert.rejects(stream.result(), /stream failed outside its contract/);
  });

  void test("prepares arguments before both hooks and execute", async () => {
    const requestingTurn: AssistantTurn = {
      items: [toolCall("call_1", "echo", { legacy: "hello" })],
      stopReason: "stop",
    };
    const order: string[] = [];
    const tool: AgentTool<{ value: string }, { value: string }> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      prepareArguments: (args) => {
        order.push("prepare");
        const legacy = (args as { legacy?: unknown }).legacy;
        if (typeof legacy !== "string") throw new Error("legacy must be a string");
        return { value: legacy };
      },
      execute: async (_toolCallId, args) => {
        order.push("execute");
        assert.equal(args.value, "HELLO");
        return { content: toolResultContent(args.value), details: args };
      },
    };

    const messages = await runAgentLoop(
      [userMessage("echo")],
      { systemPrompt: "", messages: [], tools: [tool] },
      {
        beforeToolCall: async ({ assistantMessage, args }) => {
          order.push("before");
          assert.equal(assistantMessage, requestingTurn);
          (args as { value: string }).value = "HELLO";
          return undefined;
        },
        afterToolCall: async ({ assistantMessage, args, result }) => {
          order.push("after");
          assert.equal(assistantMessage, requestingTurn);
          assert.equal((args as { value: string }).value, "HELLO");
          assert.deepEqual(result.details, { value: "HELLO" });
          return { content: toolResultContent("patched") };
        },
      },
      () => {},
      undefined,
      scriptedStream([requestingTurn, { items: [assistantMessage("done")], stopReason: "stop" }]),
    );

    assert.deepEqual(order, ["prepare", "before", "execute", "after"]);
    const output = messages.find((item) => item.type === "function_call_output")?.output;
    assert.deepEqual(output, toolResultContent("patched"));
  });

  void test("passes prepareNextTurn's replacement context to shouldStopAfterTurn", async () => {
    let observedSystemPrompt = "";
    await runAgentLoop(
      [userMessage("hello")],
      { systemPrompt: "first", messages: [] },
      {
        prepareNextTurn: ({ context }) => ({
          context: { ...context, systemPrompt: "replacement" },
        }),
        shouldStopAfterTurn: ({ context }) => {
          observedSystemPrompt = context.systemPrompt;
          return true;
        },
      },
      () => {},
      undefined,
      scriptedStream([{ items: [assistantMessage("done")], stopReason: "stop" }]),
    );

    assert.equal(observedSystemPrompt, "replacement");
  });

  void test("rejects continuation from every assistant item shape", async () => {
    const assistantItems: ResponseItem[] = [
      assistantMessage("done"),
      { type: "reasoning", encrypted_content: "opaque" },
      toolCall("call_1", "echo", {}),
    ];

    for (const item of assistantItems) {
      await assert.rejects(
        runAgentLoopContinue(
          { systemPrompt: "", messages: [item] },
          {},
          () => {},
          undefined,
          scriptedStream([]),
        ),
        { message: "Cannot continue from message role: assistant" },
      );
    }
  });

  void test("emits parallel completions in finish order and results in source order", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const tool: AgentTool<{ value: string }> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: { type: "object" },
      prepareArguments: parseValueArgument,
      execute: async (_toolCallId, args) => {
        const { value } = args;
        if (value === "first") await firstMayFinish;
        else releaseFirst?.();
        return { content: toolResultContent(value), details: {} };
      },
    };
    const events: AgentEvent[] = [];

    await runAgentLoop(
      [userMessage("echo twice")],
      { systemPrompt: "", messages: [], tools: [tool] },
      { toolExecution: "parallel" },
      (event) => {
        events.push(event);
      },
      undefined,
      scriptedStream([
        {
          items: [
            toolCall("call_1", "echo", { value: "first" }),
            toolCall("call_2", "echo", { value: "second" }),
          ],
          stopReason: "stop",
        },
        { items: [assistantMessage("done")], stopReason: "stop" },
      ]),
    );

    assert.deepEqual(
      events.flatMap((event) => (event.type === "tool_execution_end" ? [event.toolCallId] : [])),
      ["call_2", "call_1"],
    );
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === "message_end" && event.message.type === "function_call_output"
          ? [event.message.call_id]
          : [],
      ),
      ["call_1", "call_2"],
    );
  });

  void test("fails every tool call from a length-truncated turn", async () => {
    let executions = 0;
    const tool: AgentTool<{ value: string }> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: { type: "object" },
      prepareArguments: parseValueArgument,
      execute: async () => {
        executions += 1;
        return { content: toolResultContent("unexpected"), details: {} };
      },
    };

    const messages = await runAgentLoop(
      [userMessage("echo")],
      { systemPrompt: "", messages: [], tools: [tool] },
      {},
      () => {},
      undefined,
      scriptedStream([
        {
          items: [
            toolCall("call_1", "echo", { value: "one" }),
            toolCall("call_2", "echo", { value: "two" }),
          ],
          stopReason: "length",
        },
        { items: [assistantMessage("done")], stopReason: "stop" },
      ]),
    );

    assert.equal(executions, 0);
    const outputs = messages.filter((item) => item.type === "function_call_output");
    assert.equal(outputs.length, 2);
    for (const output of outputs) {
      assert.match(JSON.stringify(output.output), /output token limit/);
    }
  });

  void test("serializes asynchronous message_update sinks", async () => {
    let activeUpdates = 0;
    let maximumActiveUpdates = 0;
    const seen: string[] = [];
    const streamFn: StreamFn = async (_context, options) => {
      options.onDelta?.({ kind: "text", text: "first" });
      options.onDelta?.({ kind: "text", text: "second" });
      return { items: [assistantMessage("done")], stopReason: "stop" };
    };

    await runAgentLoop(
      [userMessage("hello")],
      { systemPrompt: "", messages: [] },
      {},
      async (event) => {
        if (event.type !== "message_update") return;
        activeUpdates += 1;
        maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        seen.push(event.delta.text);
        activeUpdates -= 1;
      },
      undefined,
      streamFn,
    );

    assert.equal(maximumActiveUpdates, 1);
    assert.deepEqual(seen, ["first", "second"]);
  });

  void test("serializes asynchronous tool update sinks", async () => {
    let activeUpdates = 0;
    let maximumActiveUpdates = 0;
    const seen: string[] = [];
    const tool: AgentTool<{ value: string }> = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: { type: "object" },
      prepareArguments: parseValueArgument,
      execute: async (_toolCallId, { value }, _signal, onUpdate) => {
        onUpdate?.({ content: toolResultContent("first"), details: undefined });
        onUpdate?.({ content: toolResultContent("second"), details: undefined });
        return { content: toolResultContent(value), details: undefined };
      },
    };

    await runAgentLoop(
      [userMessage("echo")],
      { systemPrompt: "", messages: [], tools: [tool] },
      {},
      async (event) => {
        if (event.type !== "tool_execution_update") return;
        activeUpdates += 1;
        maximumActiveUpdates = Math.max(maximumActiveUpdates, activeUpdates);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        seen.push(toolResultText(event.partialResult.content));
        activeUpdates -= 1;
      },
      undefined,
      scriptedStream([
        { items: [toolCall("call_1", "echo", { value: "done" })], stopReason: "stop" },
        { items: [assistantMessage("done")], stopReason: "stop" },
      ]),
    );

    assert.equal(maximumActiveUpdates, 1);
    assert.deepEqual(seen, ["first", "second"]);
  });
});
