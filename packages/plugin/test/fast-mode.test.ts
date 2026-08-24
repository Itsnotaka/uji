/** Fast mode is durable plugin policy, applied only to assistant requests. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  AgentHarness,
  EventStream,
  inlinePlugin,
  SqliteSessionRepo,
  systemPromptPlugin,
} from "@uji-ai/core";
import type { StreamFn } from "@uji-ai/core";
import { definePlugin } from "@uji-ai/plugin";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@uji-ai/schema";
import { fastModePlugin, readFastMode } from "../examples/fast-mode.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fastModel: Model<"openai-responses"> = {
  id: "fast-model",
  name: "Fast model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: false,
  modes: ["fast"],
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function stop(model: Model<"openai-responses">): ReturnType<StreamFn> {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: "openai",
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("stream ended without a terminal event");
    },
  );
  queueMicrotask(() => events.push({ type: "done", reason: "stop", message }));
  return events;
}

void describe("fast mode plugin", () => {
  void test("persists its selection and leaves compaction on the normal tier", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uji-fast-mode-"));
    directories.push(directory);
    const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
    const session = await repo.create();
    const seen: (boolean | undefined)[] = [];
    const streamFn: StreamFn = (model, _context, options) => {
      seen.push(options?.fast);
      return stop(model as Model<"openai-responses">);
    };
    const plugins = [
      inlinePlugin(systemPromptPlugin("sys")),
      inlinePlugin(fastModePlugin(fastModel)),
    ];
    const create = () =>
      AgentHarness.create({
        session,
        streamFn,
        plugins,
        env: { cwd: directory },
        model: fastModel,
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      });

    let harness = (await create()).harness;
    assert.equal(await readFastMode(session, fastModel), false);
    const setting = harness.getSettings().get("fast");
    assert.equal(await setting?.read(), "off");
    assert.equal(await harness.runCommand("fast"), "Fast mode: on");
    assert.equal(await setting?.read(), "on");
    await harness.prompt("one");
    await harness.prompt("two");
    assert.deepEqual(seen, [true, true]);

    const callsBeforeCompaction = seen.length;
    const compacted = await harness.compact();
    assert.equal(compacted.ok, true);
    const compactionCalls = seen.slice(callsBeforeCompaction);
    assert.ok(compactionCalls.length > 0);
    assert.equal(
      compactionCalls.every((fast) => fast === undefined),
      true,
    );
    await harness.close();

    const normalModel = {
      ...fastModel,
      id: "normal-model",
      name: "Normal model",
      modes: undefined,
    };
    harness = (
      await AgentHarness.create({
        session,
        streamFn,
        plugins: [
          inlinePlugin(systemPromptPlugin("sys")),
          inlinePlugin(fastModePlugin(normalModel)),
        ],
        env: { cwd: directory },
        model: normalModel,
      })
    ).harness;
    assert.equal(await readFastMode(session, normalModel), false);
    await harness.close();

    harness = (await create()).harness;
    assert.equal(await readFastMode(session, fastModel), true);
    await harness.prompt("three");
    assert.equal(seen.at(-1), true);

    await harness.plugins.activate([
      ...plugins,
      inlinePlugin(
        definePlugin({
          id: "normal-tier",
          session(api) {
            api.hook("before_request", () => ({ streamOptions: { fast: false } }));
          },
        }),
      ),
    ]);
    await harness.prompt("four");
    assert.equal(seen.at(-1), false);

    await harness.close();
    await session.close();
    await repo.close();
  });

  void test("keeps a selection with the provider it was made for", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uji-fast-mode-provider-"));
    directories.push(directory);
    const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
    const session = await repo.create();
    // Same session, same advertised mode, different price per token.
    const otherModel = { ...fastModel, id: "other-fast-model", provider: "anthropic" };
    const seen: (boolean | undefined)[] = [];
    const open = (model: Model<"openai-responses">) =>
      AgentHarness.create({
        session,
        streamFn: (requestedModel, _context, options) => {
          seen.push(options?.fast);
          return stop(requestedModel as Model<"openai-responses">);
        },
        plugins: [inlinePlugin(fastModePlugin(model))],
        env: { cwd: directory },
        model,
      });

    let harness = (await open(fastModel)).harness;
    assert.equal(await harness.runCommand("fast"), "Fast mode: on");
    await harness.prompt("one");
    assert.equal(seen.at(-1), true);
    await harness.close();

    harness = (await open(otherModel)).harness;
    assert.equal(await readFastMode(session, otherModel), false);
    await harness.prompt("two");
    assert.equal(seen.at(-1), undefined);
    await harness.close();

    harness = (await open(fastModel)).harness;
    assert.equal(await readFastMode(session, fastModel), true);

    await harness.close();
    await session.close();
    await repo.close();
  });

  void test("contributes nothing when the selected model does not advertise fast mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uji-fast-mode-unavailable-"));
    directories.push(directory);
    const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
    const session = await repo.create();
    const model = { ...fastModel, id: "normal-model", name: "Normal model", modes: undefined };
    const { harness } = await AgentHarness.create({
      session,
      streamFn: (requestedModel) => stop(requestedModel as Model<"openai-responses">),
      plugins: [inlinePlugin(fastModePlugin(model))],
      env: { cwd: directory },
      model,
    });

    assert.equal(harness.getCommands().has("fast"), false);
    assert.equal(harness.getSettings().has("fast"), false);
    await assert.rejects(harness.runCommand("fast"), /unknown command: fast/);
    assert.equal(await readFastMode(session, model), false);

    await harness.close();
    await session.close();
    await repo.close();
  });
});
