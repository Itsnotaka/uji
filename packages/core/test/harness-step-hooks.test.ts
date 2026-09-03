/**
 * The hooks around the assistant step, fired by the harness: transform_context
 * rewrites the system prompt, before_request patches provider options.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  Usage,
  UserMessage,
} from "@uji-ai/ai";
import { EventStream } from "@uji-ai/ai";
import type { StreamFn } from "../src/types.ts";
import { AgentHarness } from "../src/harness/agent-harness.ts";
import type { AgentHarnessStreamOptions } from "../src/harness/types.ts";
import { inlinePlugin, systemPromptPlugin } from "../src/plugins/index.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import { prompt } from "./harness-driver.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
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

interface Seen {
  systemPrompt: string | undefined;
  userTexts: string[];
  options: SimpleStreamOptions | undefined;
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** Records every request; answers "reply N". */
function recordingStream(seen: Seen[]): StreamFn {
  return (_model, context, options) => {
    seen.push({
      systemPrompt: context.systemPrompt,
      userTexts: context.messages.flatMap((m) =>
        m.role === "user" && isPlainText(m.content) ? [m.content] : [],
      ),
      options,
    });
    const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("no terminal event");
      },
    );
    queueMicrotask(() =>
      events.push({
        type: "done",
        reason: "stop",
        message: assistant(`reply ${String(seen.length)}`),
      }),
    );
    return events;
  };
}

async function open(streamOptions?: AgentHarnessStreamOptions) {
  const directory = mkdtempSync(join(tmpdir(), "uji-step-hooks-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const seen: Seen[] = [];
  const harness = await AgentHarness.create({
    session,
    streamFn: recordingStream(seen),
    plugins: [inlinePlugin(systemPromptPlugin("base"))],
    env: { cwd: directory },
    model,
    ...(streamOptions === undefined ? {} : { streamOptions }),
  });
  harness.attach();
  return {
    harness,
    session,
    seen,
    close: async () => {
      await harness.close();
      await session.close();
      await repo.close();
    },
  };
}

function isPlainText(content: UserMessage["content"]): content is string {
  return typeof content === "string";
}

void describe("assistant step hooks", () => {
  void test("transform_context rewrites the system prompt the provider sees", async () => {
    const h = await open();
    h.harness.hooks.on("transform_context", (event) => ({
      systemPrompt: `${event.systemPrompt} + plan mode`,
    }));
    await prompt(h.harness, "go");
    assert.equal(h.seen[0]?.systemPrompt, "base + plan mode");
    await h.close();
  });

  void test("before_request patches provider options", async () => {
    const h = await open();
    let step: string | undefined;
    h.harness.hooks.on("before_request", (event) => {
      step = `${event.step}:${String(event.attempt)}`;
      return { streamOptions: { temperature: 0.2, headers: { "x-trace": "t1" }, fast: true } };
    });
    await prompt(h.harness, "go");
    assert.equal(step, "assistant:1");
    assert.equal(h.seen[0]?.options?.temperature, 0.2);
    assert.deepEqual(h.seen[0]?.options?.headers, { "x-trace": "t1" });
    assert.equal(h.seen[0]?.options?.fast, true);
    await h.close();
  });

  void test("host stream defaults apply before request-hook patches", async () => {
    const h = await open({
      transport: "websocket",
      temperature: 0.1,
      headers: { "x-host": "uji" },
    });
    h.harness.hooks.on("before_request", () => ({
      streamOptions: { temperature: 0.3, headers: { "x-hook": "active" } },
    }));

    await prompt(h.harness, "go");

    assert.equal(h.seen[0]?.options?.transport, "websocket");
    assert.equal(h.seen[0]?.options?.temperature, 0.3);
    assert.deepEqual(h.seen[0]?.options?.headers, {
      "x-host": "uji",
      "x-hook": "active",
    });
    await h.close();
  });
});
