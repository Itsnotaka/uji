/** Fast mode is durable plugin policy, applied only to assistant requests. */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { EventStream } from "@uji-ai/ai";
import type { StreamFn } from "@uji-ai/core";
import { definePlugin, inlinePlugin, systemPromptPlugin } from "@uji-ai/plugin";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@uji-ai/schema";
import { FAST_MODE_PLUGIN_ID, fastModePlugin, readFastMode } from "../examples/fast-mode.ts";
import { prompt, runCommand, settingOf, TestWorkspace } from "./host.ts";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.close();
});

function workspace(prefix: string): TestWorkspace {
  const created = TestWorkspace.create(prefix);
  workspaces.push(created);
  return created;
}

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
    const world = workspace("uji-fast-mode-");
    const seen: (boolean | undefined)[] = [];
    const streamFn: StreamFn = (model, _context, options) => {
      seen.push(options?.fast);
      return stop(model as Model<"openai-responses">);
    };
    const plugins = [
      inlinePlugin(systemPromptPlugin("sys")),
      inlinePlugin(fastModePlugin(fastModel)),
    ];
    const open = () =>
      world.open({
        streamFn,
        plugins,
        model: fastModel,
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      });

    let sdk = await open();
    const { sessionId } = world;
    const currentFast = () => settingOf(sdk, sessionId, "fast");

    assert.equal(await readFastMode(await world.facts(), fastModel), false);
    assert.equal(await currentFast(), "off");
    assert.equal(await runCommand(sdk, sessionId, "fast"), "Fast mode: on");
    assert.equal(await currentFast(), "on");
    await prompt(sdk, sessionId, "one");
    await prompt(sdk, sessionId, "two");
    assert.deepEqual(seen, [true, true]);

    const callsBeforeCompaction = seen.length;
    const compacted = await sdk.runs.compact({ sessionId });
    assert.equal(compacted.kind, "compacted");
    const compactionCalls = seen.slice(callsBeforeCompaction);
    assert.ok(compactionCalls.length > 0);
    assert.equal(
      compactionCalls.every((fast) => fast === undefined),
      true,
    );
    await sdk.close();

    const normalModel = {
      ...fastModel,
      id: "normal-model",
      name: "Normal model",
      modes: undefined,
    };
    sdk = await world.open({
      streamFn,
      plugins: [inlinePlugin(systemPromptPlugin("sys")), inlinePlugin(fastModePlugin(normalModel))],
      model: normalModel,
    });
    assert.equal(await readFastMode(await world.facts(), normalModel), false);
    await sdk.close();

    sdk = await open();
    assert.equal(await readFastMode(await world.facts(), fastModel), true);
    await prompt(sdk, sessionId, "three");
    assert.equal(seen.at(-1), true);

    await sdk.setPlugins([
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
    await prompt(sdk, sessionId, "four");
    assert.equal(seen.at(-1), false);
  });

  void test("keeps a selection with the provider it was made for", async () => {
    const world = workspace("uji-fast-mode-provider-");
    // Same session, same advertised mode, different price per token.
    const otherModel = { ...fastModel, id: "other-fast-model", provider: "anthropic" };
    const seen: (boolean | undefined)[] = [];
    const open = (model: Model<"openai-responses">) =>
      world.open({
        streamFn: (requestedModel, _context, options) => {
          seen.push(options?.fast);
          return stop(requestedModel as Model<"openai-responses">);
        },
        plugins: [inlinePlugin(fastModePlugin(model))],
        model,
      });

    let sdk = await open(fastModel);
    const { sessionId } = world;
    assert.equal(await runCommand(sdk, sessionId, "fast"), "Fast mode: on");
    await prompt(sdk, sessionId, "one");
    assert.equal(seen.at(-1), true);
    await sdk.close();

    sdk = await open(otherModel);
    assert.equal(await readFastMode(await world.facts(), otherModel), false);
    await prompt(sdk, sessionId, "two");
    assert.equal(seen.at(-1), undefined);
    await sdk.close();

    sdk = await open(fastModel);
    assert.equal(await readFastMode(await world.facts(), fastModel), true);
  });

  void test("applies a setting by writing the owning plugin's storage", async () => {
    const world = workspace("uji-fast-mode-apply-");
    const sdk = await world.open({
      streamFn: (requestedModel) => stop(requestedModel as Model<"openai-responses">),
      plugins: [inlinePlugin(fastModePlugin(fastModel))],
      model: fastModel,
    });
    const { sessionId } = world;

    const listed = await sdk.plugins.settings.list({ sessionId });
    assert.deepEqual(
      listed.map(({ id, owner, current }) => ({ id, owner, current })),
      [{ id: "fast", owner: FAST_MODE_PLUGIN_ID, current: "off" }],
    );

    const apply = (id: string, choiceId: string) =>
      sdk.plugins.settings.apply({ sessionId, id, choiceId });
    assert.deepEqual(await apply("fast", "on"), { kind: "applied" });
    assert.equal(await readFastMode(await world.facts(), fastModel), true);
    assert.equal(await settingOf(sdk, sessionId, "fast"), "on");
    // The command reads the same fact the setting wrote.
    assert.equal(await runCommand(sdk, sessionId, "fast"), "Fast mode: off");

    assert.deepEqual(await apply("fast", "sideways"), { kind: "invalid_choice" });
    assert.deepEqual(await apply("missing", "on"), { kind: "not_found" });
  });

  void test("contributes nothing when the selected model does not advertise fast mode", async () => {
    const world = workspace("uji-fast-mode-unavailable-");
    const model = { ...fastModel, id: "normal-model", name: "Normal model", modes: undefined };
    const sdk = await world.open({
      streamFn: (requestedModel) => stop(requestedModel as Model<"openai-responses">),
      plugins: [inlinePlugin(fastModePlugin(model))],
      model,
    });
    const { sessionId } = world;

    const named = (list: readonly { name?: string; id?: string }[], key: string) =>
      list.some((item) => item.name === key || item.id === key);
    assert.equal(named(await sdk.plugins.commands.list({ sessionId }), "fast"), false);
    assert.equal(named(await sdk.plugins.settings.list({ sessionId }), "fast"), false);
    assert.deepEqual(await sdk.plugins.commands.run({ sessionId, name: "fast" }), {
      kind: "not_found",
    });
    assert.equal(await readFastMode(await world.facts(), model), false);
  });
});
