import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { EventStream } from "@uji-ai/ai";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import type { StreamFn } from "@uji-ai/core";
import { openHost, subscribePrint } from "../src/host.ts";

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

const otherModel: Model<"openai-responses"> = { ...model, id: "other-model", name: "Other model" };

void test("openHost runs a prompt through AgentHarness", async () => {
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
  const unsubscribe = subscribePrint(opened.harness, (chunk) => {
    chunks.push(chunk);
  });
  const result = await opened.harness.prompt("hi");
  unsubscribe();
  await opened.close();
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.kind, "completed");
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
  await first.harness.prompt("hi");
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

void test("setModel switches the model used by the next run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-cli-"));
  directories.push(directory);
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
    model,
  });
  await opened.harness.prompt("hi");
  opened.harness.setModel(otherModel);
  assert.equal(opened.harness.state.model.id, "other-model");
  await opened.harness.prompt("again");
  await opened.close();
  assert.equal(used.at(0), "test-model");
  assert.equal(used.at(-1), "other-model");
});
