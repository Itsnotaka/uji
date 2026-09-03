import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EventStream } from "@uji-ai/ai";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import type { StreamFn } from "@uji-ai/core";
import { createCliModels, lastRunEnd, openHost } from "../src/host.ts";
import type { Host } from "../src/host.ts";

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
  contextWindow: 8_000,
  maxTokens: 256,
};

function stream(message: AssistantMessage): ReturnType<StreamFn> {
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("stream ended without a terminal event");
    },
  );
  queueMicrotask(() => {
    events.push({ type: "start", partial: message });
    events.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
    events.push({ type: "done", reason: "stop", message });
  });
  return events;
}

const reply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
};

const streamFn: StreamFn = () => stream(reply);

/** Send one prompt through the SDK and wait out the run it starts. */
async function promptAndWait(host: Host, content: string): Promise<void> {
  await host.sdk.messages.send({ sessionId: host.sessionId, content });
  await host.sdk.runs.wait({ sessionId: host.sessionId });
}

void test("openHost runs a prompt through the SDK and streams its deltas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-"));
  directories.push(directory);
  const opened = await openHost({
    resume: false,
    cwd: directory,
    dbPath: join(directory, "sessions.db"),
    streamFn,
    model,
  });
  const chunks: string[] = [];
  const controller = new AbortController();
  let subscribed = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    subscribed = resolve;
  });
  const watcher = (async () => {
    for await (const event of opened.sdk.watch({
      sessionId: opened.sessionId,
      live: true,
      signal: controller.signal,
    })) {
      if (event.kind === "synced") subscribed();
      if (event.kind === "text_delta") chunks.push(event.delta);
    }
  })();
  await ready;

  await promptAndWait(opened, "hi");
  const end = await lastRunEnd(opened);
  controller.abort();
  await watcher.catch(() => undefined);
  await opened.close();
  assert.equal(end?.kind, "completed");
  assert.equal(chunks.join(""), "ok");
});

void test("resume opens the newest session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-"));
  directories.push(directory);
  const dbPath = join(directory, "sessions.db");
  const first = await openHost({
    resume: false,
    cwd: directory,
    dbPath,
    streamFn,
    model,
  });
  const sessionId = first.sessionId;
  await promptAndWait(first, "hi");
  await first.close();
  const second = await openHost({
    resume: true,
    cwd: directory,
    dbPath,
    streamFn,
    model,
  });
  assert.equal(second.sessionId, sessionId);
  await second.close();
});

void test("configure switches the model used by the next run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-"));
  directories.push(directory);
  // Real catalog entries: `configure` refuses a model the catalog cannot resolve.
  const catalog = createCliModels();
  const [firstModel, secondModel] = catalog.getModels("openai");
  assert.notEqual(firstModel, undefined);
  assert.notEqual(secondModel, undefined);
  if (firstModel === undefined || secondModel === undefined) return;

  const used: string[] = [];
  const recording: StreamFn = (requested) => {
    used.push(requested.id);
    return stream(reply);
  };
  const opened = await openHost({
    resume: false,
    cwd: directory,
    dbPath: join(directory, "sessions.db"),
    streamFn: recording,
    model: firstModel,
  });
  await promptAndWait(opened, "hi");
  const outcome = await opened.sdk.sessions.configure({
    sessionId: opened.sessionId,
    model: { provider: secondModel.provider, id: secondModel.id },
  });
  assert.equal(outcome.kind, "applied");
  await promptAndWait(opened, "again");
  await opened.close();
  assert.equal(used.at(0), firstModel.id);
  assert.equal(used.at(-1), secondModel.id);
});
