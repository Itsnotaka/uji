/**
 * The subagents awareness path: the `agents` registry becomes the `task` tool,
 * so a calling agent learns it can delegate the same way it learns of any tool.
 * Design: design.mdx, "Agents".
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import type { StreamFn } from "../src/types.ts";
import { ToolWait } from "../src/types.ts";
import type { ToolWakeContext } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import {
  buildTaskDescription,
  invokableAgents,
  subagentsPlugin,
  type SubagentHost,
} from "../src/plugins/builtin/subagents.ts";
import { definePlugin, inlinePlugin, type Agent } from "../src/plugins/index.ts";
import { SqliteSessionRepo } from "../src/store.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

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

// The tests inspect the tool set; the stream never runs, so a stopped stream is enough.
const streamFn: StreamFn = () => {
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      throw new Error("no terminal event");
    },
  );
  const usage: Usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  queueMicrotask(() => events.push({ type: "done", reason: "stop", message }));
  return events;
};

/** A host whose child is already done: spawn admits, poll reports terminal. */
const stubHost = (state: "running" | "completed" = "completed"): SubagentHost => ({
  spawn: async (request) => ({
    details: { agent: request.agent, childSessionId: "s_task_1", state: "running" },
  }),
  poll: async () => ({
    details: { agent: "explore", childSessionId: "s_task_1", state },
    ...(state === "completed" ? { text: "child result" } : {}),
  }),
  abort: async () => undefined,
});

const wakeContext = (input: { aborted?: boolean }): ToolWakeContext => ({
  signal: new AbortController().signal,
  aborted: input.aborted === true,
});

/** A plugin that contributes a fixed agent list, standing in for a real agents source. */
function agentsPlugin(id: string, agents: readonly Agent[]) {
  return inlinePlugin(
    definePlugin({
      id,
      session(api) {
        api.agents.add((draft) => {
          for (const agent of agents) draft.set(agent.id, agent);
        });
      },
    }),
  );
}

async function open(plugins: Parameters<typeof AgentHarness.create>[0]["plugins"]) {
  const directory = mkdtempSync(join(tmpdir(), "uji-subagents-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const harness = await AgentHarness.create({
    session,
    streamFn,
    plugins,
    env: { cwd: directory },
    model,
  });
  return {
    harness,
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

void describe("subagents awareness", () => {
  void test("invokableAgents drops primary, hidden, and disabled", () => {
    const agents: Agent[] = [
      { id: "build", mode: "primary" },
      { id: "explore", mode: "subagent" },
      { id: "general", mode: "all" },
      { id: "title", hidden: true },
      { id: "legacy", disabled: true },
    ];
    assert.deepEqual(
      invokableAgents(agents).map((a) => a.id),
      ["explore", "general"],
    );
  });

  void test("buildTaskDescription lists each agent's description", () => {
    const text = buildTaskDescription([
      { id: "explore", description: "Find files fast." },
      { id: "verify", description: "Check the work." },
    ]);
    assert.match(text, /- explore: Find files fast\./);
    assert.match(text, /- verify: Check the work\./);
  });

  void test("the task tool appears with registered agents in its menu", async () => {
    const h = await open([
      agentsPlugin("test-agents", [
        { id: "explore", mode: "subagent", description: "Find files fast." },
        { id: "build", mode: "primary", description: "The main agent." },
      ]),
      inlinePlugin(subagentsPlugin({ host: stubHost() })),
    ]);
    const task = h.harness.getTools().find((tool) => tool.name === "task");
    assert.ok(task, "task tool is contributed");
    assert.match(task.description, /- explore: Find files fast\./);
    assert.doesNotMatch(task.description, /build/, "primary agent is not offered to a parent");
    await h.close();
  });

  void test("no task tool when nothing is invokable", async () => {
    const h = await open([
      agentsPlugin("test-agents", [{ id: "build", mode: "primary" }]),
      inlinePlugin(subagentsPlugin({ host: stubHost() })),
    ]);
    assert.equal(
      h.harness.getTools().find((tool) => tool.name === "task"),
      undefined,
    );
    await h.close();
  });

  void test("a foreground task waits; its wake settles the child's outcome", async () => {
    const h = await open([
      agentsPlugin("test-agents", [{ id: "explore", mode: "subagent" }]),
      inlinePlugin(subagentsPlugin({ host: stubHost() })),
    ]);
    const task = h.harness.getTools().find((tool) => tool.name === "task");
    assert.ok(task);
    await assert.rejects(
      task.execute("call-1", { agent: "explore", prompt: "look" }),
      (error: unknown) => error instanceof ToolWait,
    );
    assert.ok(task.wake);
    const outcome = await task.wake(
      {
        runId: "run-1",
        toolCallId: "call-1",
        resultEntryId: "e-1",
        args: { agent: "explore", prompt: "look" },
      },
      wakeContext({}),
    );
    assert.equal(outcome.kind, "settle");
    if (outcome.kind === "settle") {
      assert.equal(outcome.isError, false);
      assert.equal(outcome.result.title, "explore");
      assert.equal(
        outcome.result.content[0]?.type === "text" && outcome.result.content[0].text,
        "child result",
      );
      assert.deepEqual(outcome.result.details, {
        agent: "explore",
        childSessionId: "s_task_1",
        state: "completed",
      });
    }
    await h.close();
  });

  void test("a wake with the child still running keeps waiting", async () => {
    const h = await open([
      agentsPlugin("test-agents", [{ id: "explore", mode: "subagent" }]),
      inlinePlugin(subagentsPlugin({ host: stubHost("running") })),
    ]);
    const task = h.harness.getTools().find((tool) => tool.name === "task");
    assert.ok(task?.wake);
    const outcome = await task.wake(
      {
        runId: "run-1",
        toolCallId: "call-1",
        resultEntryId: "e-1",
        args: { agent: "explore", prompt: "look" },
      },
      wakeContext({}),
    );
    assert.deepEqual(outcome, { kind: "wait" });
    await h.close();
  });

  void test("a background task settles immediately with the running child", async () => {
    const h = await open([
      agentsPlugin("test-agents", [{ id: "explore", mode: "subagent" }]),
      inlinePlugin(subagentsPlugin({ host: stubHost() })),
    ]);
    const task = h.harness.getTools().find((tool) => tool.name === "task");
    assert.ok(task);
    const result = await task.execute("call-1", {
      agent: "explore",
      prompt: "look",
      background: true,
    });
    assert.deepEqual(result.details, {
      agent: "explore",
      childSessionId: "s_task_1",
      state: "running",
    });
    assert.equal(
      result.content[0]?.type === "text" && result.content[0].text.includes("s_task_1"),
      true,
    );
    await h.close();
  });
});
