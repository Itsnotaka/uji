/**
 * Proof of concept for plugins.md §5 and §8 against the real harness: a
 * policy plugin blocks a tool, a profiler plugin records every call into
 * its storage, activate with a new version hot-swaps behavior, a broken
 * version keeps the old one live, and dispose removes every registration.
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
  Model,
  Usage,
} from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import type { JsonValue } from "@uji-ai/schema";
import { Type } from "typebox";
import {
  AgentHarness,
  type HarnessTool,
  inlinePlugin,
  type LoadedPlugin,
  type Plugin,
  SqliteSessionRepo,
  systemPromptPlugin,
  toolsPlugin,
} from "../src/index.ts";
import { definePlugin } from "../src/plugins/types.ts";
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

/** Every run: one bash call, then stop. */
function bashThenStop(command: string): StreamFn {
  let turn = 0;
  return () => {
    turn += 1;
    if (turn % 2 === 1) {
      return stream(
        assistant(
          [{ type: "toolCall", id: `call_${turn}`, name: "bash", arguments: { command } }],
          "toolUse",
        ),
      );
    }
    return stream(assistant([{ type: "text", text: "done" }], "stop"));
  };
}

const bashTool: HarnessTool = {
  name: "bash",
  label: "Bash",
  description: "run a command",
  parameters: Type.Object({ command: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "ran" }], details: undefined }),
};

const base: LoadedPlugin[] = [
  inlinePlugin(systemPromptPlugin("sys")),
  inlinePlugin(toolsPlugin([bashTool])),
];

function inline(plugin: Plugin, version = "1"): LoadedPlugin {
  return inlinePlugin(plugin, { version });
}

/** A third-party policy plugin can block a tool without becoming harness policy. */
const dangerousCommandGuard = definePlugin({
  id: "dangerous-command-guard",
  session(api) {
    api.hook("before_tool", (event) => {
      const command = event.args.command;
      if (event.toolName === "bash" && isString(command) && command.includes("rm -rf")) {
        return { block: { reason: "blocked by policy" } };
      }
      return undefined;
    });
  },
});

function isString(value: JsonValue): value is string {
  return typeof value === "string";
}

/** plugins.md §8: the profiler the agent writes for itself. */
const profiler = definePlugin({
  id: "me.profile",
  session(api) {
    const started = new Map<string, number>();
    api.on("tool_execution_start", (event) => {
      started.set(event.toolCallId, Date.now());
    });
    api.on("tool_execution_end", async (event) => {
      await api.storage.set(`call:${event.toolCallId}`, {
        tool: event.toolName,
        ms: Date.now() - (started.get(event.toolCallId) ?? Date.now()),
      });
    });
  },
});

async function open(streamFn: StreamFn) {
  const directory = mkdtempSync(join(tmpdir(), "uji-plugins-poc-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const { harness } = await AgentHarness.create({
    session,
    streamFn,
    plugins: base,
    env: { cwd: "/" },
    model,
  });
  const host = {
    activate: (plugins: readonly LoadedPlugin[]) => harness.plugins.activate([...base, ...plugins]),
    list: () => harness.plugins.list(),
  };
  return {
    harness,
    host,
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

function lastToolResultText(events: string[]): string | undefined {
  return events.at(-1);
}

async function runAndCollectToolResult(harness: AgentHarness): Promise<string | undefined> {
  const texts: string[] = [];
  const off = harness.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "toolResult") {
      const part = event.message.content[0];
      if (part?.type === "text") texts.push(part.text);
    }
  });
  await harness.prompt("go");
  off();
  return lastToolResultText(texts);
}

void describe("PluginHost proof of concept", () => {
  void test("a policy plugin blocks a tool; removing the plugin unblocks it", async () => {
    const h = await open(bashThenStop("rm -rf /tmp/x"));
    await h.host.activate([inline(dangerousCommandGuard)]);
    assert.equal(await runAndCollectToolResult(h.harness), "blocked by policy");

    await h.host.activate([]); // remove -> scope disposed -> hook gone
    assert.equal(await runAndCollectToolResult(h.harness), "ran");
    await h.close();
  });

  void test("a profiler plugin observes every call and keeps state in its storage", async () => {
    const h = await open(bashThenStop("ls"));
    await h.host.activate([inline(profiler)]);
    await h.harness.prompt("go");
    await h.harness.prompt("again");

    // Storage is namespaced by plugin id and survives reload: read it back
    // through a second activation of the same id.
    let calls: unknown[] = [];
    await h.host.activate([
      inline(
        definePlugin({
          id: "me.profile",
          session: async (api) => {
            calls = await api.storage.scan("call:");
          },
        }),
        "2",
      ),
    ]);
    assert.equal(calls.length, 2);
    await h.close();
  });

  void test("hot swap: version 2 replaces version 1's hooks atomically", async () => {
    const h = await open(bashThenStop("deploy"));
    const gate = (version: string, reason: string) =>
      inline(
        definePlugin({
          id: "gate",
          session(api) {
            api.hook("before_tool", () => ({ block: { reason } }));
          },
        }),
        version,
      );

    await h.host.activate([gate("1", "v1 says no")]);
    assert.equal(await runAndCollectToolResult(h.harness), "v1 says no");

    await h.host.activate([gate("2", "v2 says no")]);
    assert.equal(await runAndCollectToolResult(h.harness), "v2 says no"); // one block, not two

    await h.close();
  });

  void test("a broken new version keeps the previous version live", async () => {
    const h = await open(bashThenStop("deploy"));
    const good = inline(
      definePlugin({
        id: "gate",
        session(api) {
          api.hook("before_tool", () => ({ block: { reason: "v1 says no" } }));
        },
      }),
      "1",
    );
    const broken = inline(
      definePlugin({
        id: "gate",
        session() {
          throw new Error("syntax error, basically");
        },
      }),
      "2",
    );

    await h.host.activate([good]);
    const info = await h.host.activate([broken]);
    assert.equal(info.find((plugin) => plugin.id === "gate")?.status, "failed");
    assert.equal(await runAndCollectToolResult(h.harness), "v1 says no"); // v1 restored
    await h.close();
  });

  void test("same id and version is a no-op; the factory does not run again", async () => {
    const h = await open(bashThenStop("ls"));
    let factoryRuns = 0;
    const counted = inline(
      definePlugin({
        id: "counted",
        session() {
          factoryRuns += 1;
        },
      }),
    );
    await h.host.activate([counted]);
    await h.host.activate([counted]);
    assert.equal(factoryRuns, 1);
    await h.close();
  });
});
