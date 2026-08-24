/**
 * The hooks around the assistant step, fired by the harness: before_drive
 * refuses, before_run injects, transform_context rewrites the system prompt,
 * before_request patches provider options, before_payload sees the wire body,
 * after_response replaces the settled message, before_run_end adds a follow-up.
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
import { AgentHarness, inlinePlugin, SqliteSessionRepo, systemPromptPlugin } from "../src/index.ts";
import type { SessionStorage } from "../src/harness/session/types.ts";
import type { StreamFn } from "../src/types.ts";

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

/** Records every request; answers "reply N"; calls onPayload like an adapter would. */
function recordingStream(seen: Seen[]): StreamFn {
  return async (_model, context, options) => {
    seen.push({
      systemPrompt: context.systemPrompt,
      userTexts: context.messages.flatMap((m) =>
        m.role === "user" && isPlainText(m.content) ? [m.content] : [],
      ),
      options,
    });
    const payload = { body: "original" };
    const replaced = (await options?.onPayload?.(payload, _model)) ?? payload;
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
        message: assistant(`reply ${String(seen.length)} ${JSON.stringify(replaced)}`),
      }),
    );
    return events;
  };
}

async function open() {
  const directory = mkdtempSync(join(tmpdir(), "uji-step-hooks-"));
  directories.push(directory);
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create();
  const seen: Seen[] = [];
  const { harness } = await AgentHarness.create({
    session,
    streamFn: recordingStream(seen),
    plugins: [inlinePlugin(systemPromptPlugin("base"))],
    env: { cwd: directory },
    model,
  });
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

async function assistantTexts(session: Pick<SessionStorage, "getBranch">): Promise<string[]> {
  const branch = await session.getBranch("main");
  return branch.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant"
      ? [
          entry.message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(""),
        ]
      : [],
  );
}

void describe("assistant step hooks", () => {
  void test("before_drive: a throw refuses the run with code refused", async () => {
    const h = await open();
    h.harness.hooks.on("before_drive", () => {
      throw new Error("maintenance window");
    });
    const result = await h.harness.prompt("go");
    assert.ok(result.ok);
    assert.equal(result.value.kind, "failed");
    if (result.value.kind === "failed")
      assert.deepEqual(result.value.error, { code: "refused", message: "maintenance window" });
    assert.equal(h.seen.length, 0);
    await h.close();
  });

  void test("before_run injects messages durably before the first step", async () => {
    const h = await open();
    h.harness.hooks.on("before_run", () => ({
      messages: [{ role: "user", content: "injected context", timestamp: 0 }],
    }));
    await h.harness.prompt("go");
    assert.deepEqual(h.seen[0]?.userTexts, ["go", "injected context"]);
    const branch = await h.session.getBranch("main");
    assert.equal(branch.filter((e) => e.type === "message").length, 3);
    await h.close();
  });

  void test("transform_context rewrites the system prompt the provider sees", async () => {
    const h = await open();
    h.harness.hooks.on("transform_context", (event) => ({
      systemPrompt: `${event.systemPrompt} + plan mode`,
    }));
    await h.harness.prompt("go");
    assert.equal(h.seen[0]?.systemPrompt, "base + plan mode");
    await h.close();
  });

  void test("before_request patches provider options; before_payload rewrites the body", async () => {
    const h = await open();
    let step: string | undefined;
    h.harness.hooks.on("before_request", (event) => {
      step = `${event.step}:${String(event.attempt)}`;
      return { streamOptions: { temperature: 0.2, headers: { "x-trace": "t1" }, fast: true } };
    });
    h.harness.hooks.on("before_payload", (event) => ({
      // SAFETY: recordingStream above is the only stream here and hands `{ body }` through.
      payload: { ...(event.payload as object), body: "rewritten" },
    }));
    await h.harness.prompt("go");
    assert.equal(step, "assistant:1");
    assert.equal(h.seen[0]?.options?.temperature, 0.2);
    assert.deepEqual(h.seen[0]?.options?.headers, { "x-trace": "t1" });
    assert.equal(h.seen[0]?.options?.fast, true);
    assert.deepEqual(await assistantTexts(h.session), ['reply 1 {"body":"rewritten"}']);
    await h.close();
  });

  void test("host stream defaults apply before request-hook patches", async () => {
    const h = await open();
    h.harness.setStreamOptions({
      transport: "websocket",
      temperature: 0.1,
      headers: { "x-host": "uji" },
    });
    h.harness.hooks.on("before_request", () => ({
      streamOptions: { temperature: 0.3, headers: { "x-hook": "active" } },
    }));

    await h.harness.prompt("go");

    assert.equal(h.seen[0]?.options?.transport, "websocket");
    assert.equal(h.seen[0]?.options?.temperature, 0.3);
    assert.deepEqual(h.seen[0]?.options?.headers, {
      "x-host": "uji",
      "x-hook": "active",
    });
    await h.close();
  });

  void test("after_response replaces the settled assistant message before it is stored", async () => {
    const h = await open();
    h.harness.hooks.on("after_response", (event) => ({
      message: { ...event.message, content: [{ type: "text", text: "redacted" }] },
    }));
    await h.harness.prompt("go");
    assert.deepEqual(await assistantTexts(h.session), ["redacted"]);
    await h.close();
  });

  void test("before_run_end: a follow-up runs another step; the plugin's marker ends it", async () => {
    const h = await open();
    const marker = "[verify]";
    h.harness.hooks.on("before_run_end", (event) => {
      const asked = event.messages.some(
        (m) => m.role === "user" && isPlainText(m.content) && m.content.includes(marker),
      );
      return asked ? undefined : { followUp: `${marker} run the tests` };
    });
    const result = await h.harness.prompt("go");
    assert.ok(result.ok && result.value.kind === "completed");
    assert.equal(h.seen.length, 2);
    assert.deepEqual(h.seen[1]?.userTexts, ["go", "[verify] run the tests"]);
    assert.equal((await assistantTexts(h.session)).length, 2);
    await h.close();
  });
});
