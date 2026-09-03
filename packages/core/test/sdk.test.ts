/**
 * The SDK surface, and the acceptance scene the whole design is built for:
 * three phones send at the same moment into one session, nobody gets an error,
 * nothing forks, and one run drains all three in order.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, Model, Usage } from "@uji-ai/ai";
import { contentText, EventStream } from "@uji-ai/ai";
import {
  createUji,
  type LoadedPlugin,
  type SessionEvent,
  type SessionId,
  type Turn,
  type Uji,
} from "../src/index.ts";
import { definePlugin } from "../src/plugins/index.ts";
import type { SessionRepo } from "../src/harness/session/types.ts";
import { SqliteSessionRepo } from "../src/store.ts";
import type { StreamFn } from "../src/types.ts";
import { inlinePlugin, systemPromptPlugin, toolsFsPlugin } from "../src/plugins/index.ts";

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

/**
 * One assistant turn per request, echoing how many user messages it was given.
 * `gate` holds the turn open so a test can observe a live run and send into it.
 */
function echoStream(gate?: () => Promise<void>): StreamFn {
  return (_model, context) => {
    const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("no terminal event");
      },
    );
    const users = context.messages.filter((message) => message.role === "user").length;
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `saw ${String(users)}` }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    void (async () => {
      await gate?.();
      events.push({ type: "done", reason: "stop", message });
    })();
    return events;
  };
}

/** A gate a test opens once, and the promise the stream waits on. */
function gate(): { wait: () => Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait: () => held, open: () => open() };
}

const catalog = {
  getModels: () => [model as Model<"openai-responses">],
  getModel: (_provider: string, id: string) => (id === model.id ? model : undefined),
};

async function open(
  held?: () => Promise<void>,
  extraPlugins: readonly LoadedPlugin[] = [],
): Promise<{ uji: Uji; cwd: string; close: () => Promise<void> }> {
  const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-"));
  directories.push(cwd);
  const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
  const uji = await createUji({
    store,
    streamFn: echoStream(held),
    models: catalog,
    model,
    plugins: [
      inlinePlugin(systemPromptPlugin("test")),
      inlinePlugin(toolsFsPlugin()),
      ...extraPlugins,
    ],
    env: { cwd },
  });
  return {
    uji,
    cwd,
    close: async () => {
      await uji.close();
      await store.close();
    },
  };
}

const userTexts = (turns: readonly Turn[]): string[] =>
  turns.flatMap((turn) =>
    turn.kind === "turn"
      ? turn.parts.filter((part) => part.kind === "user").map((part) => contentText(part.content))
      : [],
  );

/** Replay the durable stream up to `synced` and hand back what a client saw. */
async function replay(uji: Uji, sessionId: SessionId): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of uji.watch({ sessionId })) {
    if (event.kind === "synced") break;
    events.push(event);
  }
  return events;
}

describe("three phones", () => {
  void test("concurrent sends into an idle session all land, in order, on one head", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();

    const receipts = await Promise.all([
      uji.messages.send({ sessionId, content: "one" }),
      uji.messages.send({ sessionId, content: "two" }),
      uji.messages.send({ sessionId, content: "three" }),
    ]);

    // Nobody gets an error for talking at the same time.
    assert.equal(receipts.length, 3);
    assert.equal(
      receipts.every((receipt) => receipt.kind === "placed" || receipt.kind === "queued"),
      true,
    );
    // Nothing forks: one head, and every send is on its branch in send order.
    const heads = (await uji.sessions.get({ sessionId }))?.heads ?? [];
    assert.equal(heads.length, 1);
    assert.deepEqual(userTexts(await uji.messages.list({ sessionId })), ["one", "two", "three"]);

    await close();
  });

  void test("a send behind a live run is queued, and one run drains every message", async () => {
    const turn = gate();
    const { uji, close } = await open(turn.wait);
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();

    const first = await uji.messages.send({ sessionId, content: "one" });
    assert.equal(first.kind, "placed");

    // The held turn keeps the claim alive long enough to send into a live run.
    let live = await uji.runs.current({ sessionId });
    for (let attempt = 0; attempt < 200 && live?.kind !== "live"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      live = await uji.runs.current({ sessionId });
    }
    assert.equal(live?.kind, "live");

    const [second, third] = await Promise.all([
      uji.messages.send({ sessionId, content: "two" }),
      uji.messages.send({ sessionId, content: "three" }),
    ]);
    assert.deepEqual([second?.kind, third?.kind], ["queued", "queued"]);

    turn.open();
    await uji.runs.wait({ sessionId });
    assert.deepEqual(userTexts(await uji.messages.list({ sessionId })), ["one", "two", "three"]);
    assert.equal(await uji.runs.current({ sessionId }), undefined);

    detach();
    await close();
  });

  void test("a pending message moves between delivery lanes and keeps its id", async () => {
    const turn = gate();
    const { uji, close } = await open(turn.wait);
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();

    await uji.messages.send({ sessionId, content: "one" });
    let live = await uji.runs.current({ sessionId });
    for (let attempt = 0; attempt < 200 && live?.kind !== "live"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      live = await uji.runs.current({ sessionId });
    }
    assert.equal(live?.kind, "live");

    const queued = await uji.messages.send({ sessionId, content: "two", delivery: "queue" });
    assert.equal(queued.kind, "queued");
    if (queued.kind !== "queued") throw new Error("expected a queued receipt");
    assert.deepEqual(
      (await uji.messages.pending({ sessionId })).map((item) => [item.entryId, item.delivery]),
      [[queued.entryId, "queue"]],
    );
    assert.deepEqual(
      (await uji.sessions.snapshot({ sessionId }))?.pending.map((item) => [
        item.entryId,
        item.delivery,
      ]),
      [[queued.entryId, "queue"]],
    );

    assert.deepEqual(
      await uji.messages.redeliver({ sessionId, entryId: queued.entryId, delivery: "steer" }),
      { kind: "redelivered", delivery: "steer" },
    );
    // Same id, same place, new lane.
    assert.deepEqual(
      (await uji.messages.pending({ sessionId })).map((item) => [item.entryId, item.delivery]),
      [[queued.entryId, "steer"]],
    );
    assert.deepEqual(
      (await uji.sessions.snapshot({ sessionId }))?.pending.map((item) => [
        item.entryId,
        item.delivery,
      ]),
      [[queued.entryId, "steer"]],
    );
    assert.deepEqual(
      await uji.messages.redeliver({ sessionId, entryId: queued.entryId, delivery: "steer" }),
      { kind: "unchanged", delivery: "steer" },
    );

    turn.open();
    await uji.runs.wait({ sessionId });
    assert.deepEqual(userTexts(await uji.messages.list({ sessionId })), ["one", "two"]);
    assert.deepEqual(
      await uji.messages.redeliver({ sessionId, entryId: queued.entryId, delivery: "queue" }),
      { kind: "already_consumed" },
    );

    detach();
    await close();
  });

  void test("a repeated entryId is a duplicate, not a second message", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();
    const key = "phone-retry" as never;

    const first = await uji.messages.send({ sessionId, content: "one", entryId: key });
    const retry = await uji.messages.send({ sessionId, content: "one", entryId: key });

    assert.equal(first.kind, "placed");
    assert.deepEqual(retry, { kind: "duplicate", entryId: first.entryId });
    assert.deepEqual(userTexts(await uji.messages.list({ sessionId })), ["one"]);

    await close();
  });
});

describe("namespaces", () => {
  void test("sessions create, get, rename, and list with a cursor", async () => {
    const { uji, close } = await open();
    const created = await uji.sessions.create({ name: "first" });
    await uji.sessions.create({ name: "second" });

    assert.equal(created.name, "first");
    assert.equal((await uji.sessions.get({ sessionId: created.sessionId }))?.name, "first");
    assert.equal(await uji.sessions.get({ sessionId: "nope" as SessionId }), undefined);

    await uji.sessions.rename({ sessionId: created.sessionId, name: "renamed" });
    assert.equal((await uji.sessions.get({ sessionId: created.sessionId }))?.name, "renamed");

    const page = await uji.sessions.list({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.notEqual(page.next, undefined);
    const rest = await uji.sessions.list({ cursor: page.next });
    assert.equal(rest.items.length, 1);
    assert.equal(rest.next, undefined);

    await close();
  });

  void test("delete settles the session and removes it from the directory", async () => {
    const { uji, close } = await open();
    const kept = await uji.sessions.create({ name: "kept" });
    const doomed = await uji.sessions.create({ name: "doomed" });
    await uji.messages.send({ sessionId: doomed.sessionId, content: "bye" });

    await uji.sessions.delete({ sessionId: doomed.sessionId });
    assert.equal(await uji.sessions.get({ sessionId: doomed.sessionId }), undefined);
    assert.deepEqual(
      (await uji.sessions.list()).items.map((info) => info.sessionId),
      [kept.sessionId],
    );
    await close();
  });

  void test("configure declares run inputs in the tree and the next run uses them", async () => {
    const second: Model<"openai-responses"> = {
      ...model,
      id: "second-model",
      contextWindow: 50_000,
    };
    const seen: string[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-config-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const base = echoStream();
    const uji = await createUji({
      store,
      streamFn: (requested, context, streamOptions) => {
        seen.push(requested.id);
        return base(requested, context, streamOptions);
      },
      models: {
        ...catalog,
        getModels: () => [model, second],
        getModel: (_provider: string, id: string) =>
          [model, second].find((candidate) => candidate.id === id),
      },
      model,
      plugins: [inlinePlugin(systemPromptPlugin("test")), inlinePlugin(toolsFsPlugin())],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();

    assert.deepEqual(
      await uji.sessions.configure({ sessionId, model: { provider: "openai", id: "missing" } }),
      { kind: "unknown_model" },
    );
    assert.deepEqual(
      await uji.sessions.configure({
        sessionId,
        model: { provider: "openai", id: "second-model" },
        thinkingLevel: "off",
      }),
      { kind: "applied" },
    );
    assert.deepEqual((await uji.sessions.get({ sessionId }))?.config, {
      model: { provider: "openai", id: "second-model" },
      thinkingLevel: "off",
    });
    // The gauge measures against the declared model, not the host fallback.
    assert.equal((await uji.sessions.snapshot({ sessionId }))?.context.contextWindow, 50_000);

    const detach = uji.attach();
    await uji.messages.send({ sessionId, content: "hello" });
    let finished = false;
    for (let attempt = 0; attempt < 200 && !finished; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = (await replay(uji, sessionId)).some((event) => event.kind === "run_finished");
    }
    assert.equal(finished, true);
    assert.equal(seen.at(-1), "second-model");

    detach();
    await uji.close();
    await store.close();
  });

  void test("messages expose the transcript and the pending queue", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();
    await uji.messages.send({ sessionId, content: "hello" });

    assert.deepEqual(userTexts(await uji.messages.list({ sessionId })), ["hello"]);
    assert.deepEqual(await uji.messages.pending({ sessionId }), []);

    await close();
  });

  void test("sessions snapshot returns one complete read model and watch cursor", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create({ name: "snapshot" });
    await uji.messages.send({ sessionId, content: "one" });

    const snapshot = await uji.sessions.snapshot({ sessionId });
    assert.notEqual(snapshot, undefined);
    if (snapshot === undefined) throw new Error("expected a session snapshot");
    assert.equal(snapshot.session.name, "snapshot");
    assert.deepEqual(userTexts(snapshot.transcript), ["one"]);
    assert.deepEqual(snapshot.pending, []);
    assert.equal(snapshot.context.contextWindow, model.contextWindow);

    const second = await uji.messages.send({ sessionId, content: "two" });
    const events: SessionEvent[] = [];
    for await (const event of uji.watch({ sessionId, afterSeq: snapshot.seq })) {
      if (event.kind === "synced") break;
      events.push(event);
    }
    assert.deepEqual(
      events.filter((event) => event.kind === "message").map((event) => event.entryId),
      [second.entryId],
    );
    assert.equal(await uji.sessions.snapshot({ sessionId: "missing" as SessionId }), undefined);

    await close();
  });

  void test("runs settle an abort and a compaction request on an idle head", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();

    assert.deepEqual(await uji.runs.abort({ sessionId }), { kind: "not_running" });
    assert.deepEqual(await uji.runs.compact({ sessionId }), { kind: "nothing_to_compact" });

    await close();
  });

  void test("heads move is a durable navigation run with an honest event trail", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();
    const placed = await uji.messages.send({ sessionId, content: "one" });
    await uji.messages.send({ sessionId, content: "two" });

    // Selecting a user message parks the head on its parent and hands the
    // message back, so a client can offer it for editing.
    const moved = await uji.heads.move({ sessionId, to: placed.entryId });
    assert.equal(moved.kind, "moved");
    if (moved.kind !== "moved") throw new Error("expected a move");
    assert.deepEqual(moved.restored, { entryId: placed.entryId, content: "one" });
    assert.deepEqual((await uji.sessions.get({ sessionId }))?.heads[0]?.entryId, null);

    // The move ran as a structural run: the replayed stream shows the
    // operation bracket, and the deliberate move is distinguishable from the
    // two append-throughs because the cause is stored, not guessed.
    const events = await replay(uji, sessionId);
    const started = events.flatMap((event) => (event.kind === "run_started" ? [event] : []));
    const finished = events.flatMap((event) => (event.kind === "run_finished" ? [event] : []));
    assert.equal(started.length, 1);
    assert.equal(started[0]?.operation, "navigation");
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.runId, started[0]?.runId);
    assert.deepEqual(finished[0]?.outcome, { kind: "completed" });
    assert.deepEqual(
      events.flatMap((event) => (event.kind === "head_moved" ? [event.by] : [])),
      ["append", "append", "move"],
    );

    assert.deepEqual(await uji.heads.move({ sessionId, to: "missing" as never }), {
      kind: "not_found",
    });

    await close();
  });

  void test("plugins list their inventory, commands, settings, and resources", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-plugins-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: echoStream(),
      models: catalog,
      model,
      env: { cwd },
      plugins: [
        inlinePlugin(
          definePlugin({
            id: "tiers",
            session(api) {
              api.commands.add((commands) =>
                commands.set("tier", { description: "Show the tier", run: () => "fast" }),
              );
              api.settings.add((settings) =>
                settings.set("tier", {
                  label: "Tier",
                  key: "tier",
                  fallback: "normal",
                  choices: [
                    { id: "fast", label: "fast" },
                    { id: "normal", label: "normal" },
                  ],
                }),
              );
            },
          }),
        ),
      ],
    });
    const { sessionId } = await uji.sessions.create();

    // The trailing `subagents` is the SDK's own builtin, composed per session.
    assert.deepEqual(
      (await uji.plugins.list({ sessionId })).map((plugin) => plugin.id),
      ["tiers", "subagents"],
    );
    assert.deepEqual(await uji.plugins.commands.list({ sessionId }), [
      { name: "tier", owner: "tiers", description: "Show the tier" },
    ]);
    assert.deepEqual(await uji.plugins.commands.run({ sessionId, name: "tier" }), {
      kind: "ran",
      output: "fast",
    });
    assert.deepEqual(await uji.plugins.commands.run({ sessionId, name: "missing" }), {
      kind: "not_found",
    });

    assert.equal((await uji.plugins.settings.list({ sessionId }))[0]?.current, "normal");
    assert.deepEqual(
      await uji.plugins.settings.apply({ sessionId, id: "tier", choiceId: "fast" }),
      {
        kind: "applied",
      },
    );
    assert.equal((await uji.plugins.settings.list({ sessionId }))[0]?.current, "fast");
    assert.deepEqual(await uji.plugins.resources.list({ sessionId }), []);

    await uji.close();
    await store.close();
  });

  void test("setPlugins re-activates open sessions against the new list", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();
    assert.deepEqual(
      (await uji.plugins.list({ sessionId })).map((plugin) => plugin.id),
      ["system-prompt", "tools-fs", "subagents"],
    );

    await uji.setPlugins([
      inlinePlugin(systemPromptPlugin("test")),
      inlinePlugin(
        definePlugin({
          id: "late",
          session(api) {
            api.commands.add((commands) =>
              commands.set("late", { description: "added by reload", run: () => "here" }),
            );
          },
        }),
      ),
    ]);
    // Reload keeps the SDK's builtin: hosts swap their list, not the composition.
    assert.deepEqual(
      (await uji.plugins.list({ sessionId })).map((plugin) => plugin.id),
      ["system-prompt", "late", "subagents"],
    );
    assert.deepEqual(await uji.plugins.commands.run({ sessionId, name: "late" }), {
      kind: "ran",
      output: "here",
    });
    await close();
  });

  void test("provider reports the catalog", async () => {
    const { uji, close } = await open();
    assert.deepEqual(
      (await uji.provider.models.list()).map((info) => info.id),
      ["test-model"],
    );
    assert.equal((await uji.provider.models.default())?.id, "test-model");
    await close();
  });
});

describe("watch", () => {
  void test("replays from the cursor, emits synced, then streams live items", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();
    await uji.messages.send({ sessionId, content: "one" });

    const controller = new AbortController();
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of uji.watch({ sessionId, signal: controller.signal })) {
        seen.push(event.kind);
        if (seen.filter((kind) => kind === "message").length === 2) {
          controller.abort();
          return;
        }
      }
    })();

    // The replay must be complete before the live item arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await uji.messages.send({ sessionId, content: "two" });
    await pump.catch(() => undefined);

    assert.equal(seen.includes("synced"), true);
    assert.equal(seen.indexOf("message") < seen.indexOf("synced"), true);
    assert.equal(seen.filter((kind) => kind === "message").length, 2);

    await close();
  });
});

/** Reject after `ms`, clearing the timer either way so a failure cannot outlive the test. */
async function withTimeout<T>(promise: Promise<T>, message: string, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a durable predicate at a short interval, bounded by `ms`. */
async function until(check: () => Promise<boolean>, message: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(5);
  }
}

interface HeldTurn {
  streamFn: StreamFn;
  /** The provider was called: the run is live and holds the claim. */
  entered: Promise<void>;
  /** The runner's abort signal fired against the held request. */
  aborted: Promise<void>;
  release: () => void;
}

/**
 * The first request is held open until released or aborted; a durable abort
 * reaches it through the runner's signal, so the run can end as `aborted`
 * without the test opening the gate. Later requests answer at once.
 */
function heldTurn(): HeldTurn {
  const entered = gate();
  const aborted = gate();
  const released = gate();
  let call = 0;
  const finish = (
    events: EventStream<AssistantMessageEvent, AssistantMessage>,
    stop: "stop" | "aborted",
  ) => {
    const message: AssistantMessage = {
      role: "assistant",
      content: stop === "stop" ? [{ type: "text", text: "held" }] : [],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: stop,
      timestamp: Date.now(),
    };
    if (stop === "stop") events.push({ type: "done", reason: "stop", message });
    else events.push({ type: "error", reason: "aborted", error: message });
  };
  const streamFn: StreamFn = (requested, context, streamOptions) => {
    call += 1;
    if (call > 1) return echoStream()(requested, context, streamOptions);
    const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("no terminal event");
      },
    );
    let settled = false;
    const settle = (stop: "stop" | "aborted"): void => {
      if (settled) return;
      settled = true;
      finish(events, stop);
    };
    const onAbort = (): void => {
      aborted.open();
      settle("aborted");
    };
    const signal = streamOptions?.signal;
    if (signal?.aborted === true) queueMicrotask(onAbort);
    else signal?.addEventListener("abort", onAbort, { once: true });
    void released.wait().then(() => settle("stop"));
    entered.open();
    return events;
  };
  return { streamFn, entered: entered.wait(), aborted: aborted.wait(), release: released.open };
}

/** The first terminal run event a live watch delivers. */
function firstRunFinished(
  uji: Uji,
  sessionId: SessionId,
): Promise<Extract<SessionEvent, { kind: "run_finished" }>> {
  return (async () => {
    for await (const event of uji.watch({ sessionId, live: true })) {
      if (event.kind === "run_finished") return event;
    }
    throw new Error("watch ended before the run finished");
  })();
}

const runStarted = async (uji: Uji, sessionId: SessionId): Promise<boolean> =>
  (await replay(uji, sessionId)).some((event) => event.kind === "run_started");

describe("lifecycle", () => {
  void test("a disposer that runs before the session listing resolves attaches nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-attach-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const listing = gate();
    // The listing is what `attach` awaits first; holding it models a slow store.
    const slowStore: SessionRepo = {
      create: (options) => store.create(options),
      open: (id) => store.open(id),
      list: async () => {
        await listing.wait();
        return store.list();
      },
      delete: (id) => store.delete(id),
    };
    const uji = await createUji({
      store: slowStore,
      streamFn: echoStream(),
      models: catalog,
      model,
      plugins: [inlinePlugin(systemPromptPlugin("test"))],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();

    const detach = uji.attach();
    detach();
    listing.open();
    await uji.messages.send({ sessionId, content: "anyone there?" });
    // Bounded negative check: a withdrawn attachment must not start a run once
    // the listing lands. Then a fresh attachment proves the session is runnable.
    await sleep(150);
    assert.equal(await runStarted(uji, sessionId), false);
    const again = uji.attach();
    await until(() => runStarted(uji, sessionId), "the second attachment never ran the placement");
    await uji.runs.wait({ sessionId });
    again();

    await uji.close();
    await store.close();
  });

  void test("a session keeps its runner while any attachment covers it", async () => {
    const { uji, close } = await open();
    const first = uji.attach();
    const second = uji.attach();
    const early = await uji.sessions.create();
    first();
    // Created while both were attached; the first disposer must not strip it.
    await uji.messages.send({ sessionId: early.sessionId, content: "one" });
    await until(() => runStarted(uji, early.sessionId), "early session lost its runner");
    await uji.runs.wait({ sessionId: early.sessionId });
    // Created after the first disposer ran; the second attachment still covers it.
    const late = await uji.sessions.create();
    await uji.messages.send({ sessionId: late.sessionId, content: "two" });
    await until(() => runStarted(uji, late.sessionId), "late session got no runner");
    await uji.runs.wait({ sessionId: late.sessionId });

    second();
    const after = await uji.sessions.create();
    await uji.messages.send({ sessionId: after.sessionId, content: "three" });
    await sleep(150);
    assert.equal(await runStarted(uji, after.sessionId), false);
    await close();
  });

  void test("delete aborts a run this process drives and waits for its terminal record", async () => {
    const held = heldTurn();
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-delete-local-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: held.streamFn,
      models: catalog,
      model,
      plugins: [inlinePlugin(systemPromptPlugin("test"))],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();
    await uji.messages.send({ sessionId, content: "hold" });
    await withTimeout(held.entered, "the provider was never called");
    const finished = firstRunFinished(uji, sessionId);

    await withTimeout(uji.sessions.delete({ sessionId }), "delete never settled");
    assert.equal((await withTimeout(finished, "no terminal record")).outcome.kind, "aborted");
    await withTimeout(held.aborted, "the held request was never aborted");
    assert.equal(await uji.sessions.get({ sessionId }), undefined);
    assert.deepEqual(await store.list(), []);

    detach();
    await uji.close();
    await store.close();
  });

  void test("delete aborts a run another process drives and waits for its claim to go", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-delete-remote-"));
    directories.push(cwd);
    const path = join(cwd, "sessions.db");
    // Two repos on one file stand in for two processes: each has its own
    // change tracker, so the deleter learns of the release only by polling.
    const runnerStore = new SqliteSessionRepo(path, { watchPollIntervalMs: 10 });
    const deleterStore = new SqliteSessionRepo(path, { watchPollIntervalMs: 10 });
    const held = heldTurn();
    const plugins = [inlinePlugin(systemPromptPlugin("test"))];
    const runner = await createUji({
      store: runnerStore,
      streamFn: held.streamFn,
      models: catalog,
      model,
      plugins,
      env: { cwd },
    });
    const deleter = await createUji({
      store: deleterStore,
      streamFn: echoStream(),
      models: catalog,
      model,
      plugins,
      env: { cwd },
    });
    const { sessionId } = await runner.sessions.create();
    const detach = runner.attach();
    await runner.messages.send({ sessionId, content: "hold" });
    await withTimeout(held.entered, "the provider was never called");
    assert.equal((await deleter.runs.current({ sessionId }))?.kind, "live");
    const finished = firstRunFinished(runner, sessionId);

    // The deleter drives nothing here, so its harness has nothing to close;
    // the abort must be durable and the wait must outlast the other holder.
    await withTimeout(deleter.sessions.delete({ sessionId }), "delete never settled");
    const end = await withTimeout(finished, "no terminal record from the runner");
    assert.equal(end.outcome.kind, "aborted");
    await withTimeout(held.aborted, "the held request was never aborted");
    assert.equal(await deleter.sessions.get({ sessionId }), undefined);
    assert.deepEqual(await deleterStore.list(), []);
    // The runner's store agrees the rows are gone. (Its Uji still pools the
    // handle it opened; evicting pooled sessions deleted elsewhere is not
    // part of this verb.)
    assert.deepEqual(await runnerStore.list(), []);
    assert.equal(await runner.runs.current({ sessionId }), undefined);

    detach();
    await runner.close();
    await deleter.close();
    await runnerStore.close();
    await deleterStore.close();
  });

  void test("close settles a harness still being built for a runner and owns nothing after", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-close-race-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    // Activation blocks inside AgentHarness.create until the gate opens, so
    // close runs while the runner's harness build is in flight.
    const building = gate();
    const entered = gate();
    const slow = definePlugin({
      id: "slow",
      async session() {
        entered.open();
        await building.wait();
      },
    });
    const uji = await createUji({
      store,
      streamFn: echoStream(),
      models: catalog,
      model,
      plugins: [inlinePlugin(slow)],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const detach = uji.attach();
      await withTimeout(entered.wait(), "the harness build never started");
      const closing = uji.close();
      building.open();
      await withTimeout(closing, "close never settled");
      detach();
      assert.throws(() => uji.attach(), { name: "UjiClosed" });
      await assert.rejects(uji.sessions.get({ sessionId }), { name: "UjiClosed" });
      // Rejections surface after the microtask queue drains; one macrotask is enough.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // Every storage handle was closed by the Uji; the repo has nothing left to report.
    await store.close();
  });

  /**
   * A Uji whose only plugin reports whether it was ever activated. No
   * attachment, so `sessions.create` pools the session without a harness and
   * the first verb needing one is what builds it.
   */
  async function openWithProbe(): Promise<{
    uji: Uji;
    store: SqliteSessionRepo;
    activated: () => boolean;
  }> {
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-probe-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    let activated = false;
    const probe = definePlugin({
      id: "probe",
      session() {
        activated = true;
      },
    });
    const uji = await createUji({
      store,
      streamFn: echoStream(),
      models: catalog,
      model,
      plugins: [inlinePlugin(probe)],
      env: { cwd },
    });
    return { uji, store, activated: () => activated };
  }

  void test("sessions snapshot does not activate plugins", async () => {
    const { uji, store, activated } = await openWithProbe();
    const { sessionId } = await uji.sessions.create();

    const snapshot = await uji.sessions.snapshot({ sessionId });
    assert.notEqual(snapshot, undefined);
    assert.equal(activated(), false);

    await uji.close();
    await store.close();
  });

  void test("a harness asked for in the gap before close is refused before it builds", async () => {
    const { uji, store, activated } = await openWithProbe();
    const { sessionId } = await uji.sessions.create();
    // `plugins.list` passes alive() and awaits the pooled session: one microtask.
    // `close` flips `closed` synchronously, so the continuation finds it set.
    const listing = uji.plugins.list({ sessionId });
    const closing = uji.close();
    await assert.rejects(listing, { name: "UjiClosed" });
    await withTimeout(closing, "close never settled");
    assert.equal(activated(), false);
    await store.close();
  });

  void test("a harness asked for in the gap before delete is refused before it builds", async () => {
    const { uji, store, activated } = await openWithProbe();
    const { sessionId } = await uji.sessions.create();
    // Both verbs await the pooled session once; continuations run in call
    // order, so delete retires the session before `plugins.list` reaches harnessFor.
    const deleting = uji.sessions.delete({ sessionId });
    const listing = uji.plugins.list({ sessionId });
    await assert.rejects(listing, { name: "UnknownSession" });
    await withTimeout(deleting, "delete never settled");
    assert.equal(activated(), false);
    assert.equal(await uji.sessions.get({ sessionId }), undefined);
    await uji.close();
    await store.close();
  });
});

/** First turn writes `view.md` through the real `write` tool, second turn stops. */
function writeThenStop(): StreamFn {
  let turn = 0;
  return () => {
    const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("no terminal event");
      },
    );
    turn += 1;
    const message: AssistantMessage =
      turn === 1
        ? {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_1",
                name: "write",
                arguments: { path: "view.md", content: "hello\n" },
              },
            ],
            api: "openai-responses",
            provider: "openai",
            model: "test-model",
            usage,
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: "written" }],
            api: "openai-responses",
            provider: "openai",
            model: "test-model",
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
          };
    queueMicrotask(() => {
      events.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
    });
    return events;
  };
}

describe("parity verbs", () => {
  void test("parent links land at creation and filter the directory", async () => {
    const { uji, close } = await open();
    const root = await uji.sessions.create({ name: "root" });
    const parent = {
      sessionId: root.sessionId,
      runId: "r1",
      callId: "call_1",
      agent: "explore",
      depth: 1,
    };
    const child = await uji.sessions.create({ name: "child", parent });

    assert.deepEqual(child.parent, parent);
    assert.deepEqual((await uji.sessions.get({ sessionId: root.sessionId }))?.parent, undefined);

    const roots = await uji.sessions.list({ parent: null });
    assert.deepEqual(
      roots.items.map((info) => info.sessionId),
      [root.sessionId],
    );
    const children = await uji.sessions.list({ parent: root.sessionId });
    assert.deepEqual(
      children.items.map((info) => info.sessionId),
      [child.sessionId],
    );
    const everyone = await uji.sessions.list();
    assert.equal(everyone.items.length, 2);

    await close();
  });

  void test("a drained queue item leaves a durable queue_consumed event", async () => {
    const turn = gate();
    const { uji, close } = await open(turn.wait);
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();

    await uji.messages.send({ sessionId, content: "one" });
    await until(
      async () => (await uji.runs.current({ sessionId }))?.kind === "live",
      "run never went live",
    );
    const queued = await uji.messages.send({ sessionId, content: "two" });
    assert.equal(queued.kind, "queued");

    turn.open();
    await uji.runs.wait({ sessionId });
    const events = await replay(uji, sessionId);
    assert.equal(
      events.some((event) => event.kind === "queued" && event.item.entryId === queued.entryId),
      true,
    );
    assert.equal(
      events.some((event) => event.kind === "queue_consumed" && event.entryId === queued.entryId),
      true,
    );

    detach();
    await close();
  });

  void test("wake: false admits without starting a run; the next send drains both", async () => {
    const { uji, close } = await open();
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();

    await uji.messages.send({ sessionId, content: "imported", wake: false });
    await uji.messages.send({ sessionId, content: "go" });
    await uji.runs.wait({ sessionId });

    // One run, one turn, and the provider saw both messages at once. A woken
    // import would instead answer "saw 1" before "saw 2", on one run or two.
    const assistantTexts = (await uji.messages.list({ sessionId })).flatMap((turn) =>
      turn.kind === "turn"
        ? turn.parts.flatMap((part) => (part.kind === "assistant" ? [part.text] : []))
        : [],
    );
    assert.deepEqual(assistantTexts, ["saw 2"]);
    const events = await replay(uji, sessionId);
    assert.equal(events.filter((event) => event.kind === "run_started").length, 1);

    detach();
    await close();
  });

  void test("a declared agent drives the run: recorded, layered, filtered", async () => {
    const seen: { systemPrompt: string; tools: string[] }[] = [];
    const capturing: StreamFn = (_model, context) => {
      seen.push({
        systemPrompt: context.systemPrompt ?? "",
        tools: (context.tools ?? []).map((tool) => tool.name),
      });
      const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return event.message;
          if (event.type === "error") return event.error;
          throw new Error("no terminal event");
        },
      );
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "arr" }],
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
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: capturing,
      models: catalog,
      model,
      plugins: [
        inlinePlugin(systemPromptPlugin("base prompt")),
        inlinePlugin(toolsFsPlugin()),
        inlinePlugin(
          definePlugin({
            id: "agents-test",
            session(api) {
              api.agents.add((draft) => {
                draft.set("pirate", {
                  id: "pirate",
                  system: "Answer as a pirate.",
                });
              });
            },
          }),
        ),
      ],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();

    assert.deepEqual(await uji.sessions.configure({ sessionId, agent: "missing" }), {
      kind: "unknown_agent",
    });

    const detach = uji.attach();
    await uji.messages.send({ sessionId, content: "ahoy", agent: "pirate" });
    await uji.runs.wait({ sessionId });

    const started = (await replay(uji, sessionId)).find((event) => event.kind === "run_started");
    assert.equal(started?.kind === "run_started" ? started.agent : undefined, "pirate");
    assert.equal(seen[0]?.systemPrompt.endsWith("Answer as a pirate."), true);
    assert.equal(seen[0]?.systemPrompt.includes("base prompt"), true);
    // The agent record layers a persona; the catalog is untouched by it.
    assert.equal(seen[0]?.tools.includes("read"), true);
    assert.equal(seen[0]?.tools.includes("write"), true);
    assert.equal((await uji.sessions.get({ sessionId }))?.config.agent, "pirate");

    detach();
    await uji.close();
    await store.close();
  });

  void test("every agent receives the complete registered tool catalog", async () => {
    const seen: string[][] = [];
    const capturing: StreamFn = (_model, context) => {
      seen.push((context.tools ?? []).map((tool) => tool.name));
      const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return event.message;
          if (event.type === "error") return event.error;
          throw new Error("no terminal event");
        },
      );
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
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: capturing,
      models: catalog,
      model,
      plugins: [
        inlinePlugin(toolsFsPlugin()),
        inlinePlugin(
          definePlugin({
            id: "agents-defaults",
            session(api) {
              api.agents.add((draft) => {
                draft.set("scout", { id: "scout", mode: "subagent" });
                draft.set("ranger", { id: "ranger", mode: "subagent", system: "Range." });
                draft.set("plain", { id: "plain" });
              });
            },
          }),
        ),
      ],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();
    for (const agent of ["scout", "ranger", "plain"]) {
      await uji.messages.send({ sessionId, content: "go", agent });
      await uji.runs.wait({ sessionId });
    }

    // `mode` narrows who may select an agent, never what it may call: a
    // subagent-mode record, one with a persona, and a plain one all see the
    // same catalog. Per-call limits are `before_tool` policies, not records.
    assert.equal(seen.length, 3);
    for (const tools of seen) {
      assert.equal(tools.includes("read"), true);
      assert.equal(tools.includes("write"), true);
    }

    detach();
    await uji.close();
    await store.close();
  });

  void test("task delegates to a durable child session and settles TaskDetails", async () => {
    const captured: { sys: string; tools: string[] }[] = [];
    let parentTurn = 0;
    const scripted: StreamFn = (_model, context) => {
      const sys = context.systemPrompt ?? "";
      captured.push({ sys, tools: (context.tools ?? []).map((tool) => tool.name) });
      const child = sys.includes("You are Scout.");
      const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return event.message;
          if (event.type === "error") return event.error;
          throw new Error("no terminal event");
        },
      );
      const base = {
        role: "assistant" as const,
        api: "openai-responses" as const,
        provider: "openai",
        model: "test-model",
        usage,
        timestamp: Date.now(),
      };
      let message: AssistantMessage;
      if (child) {
        message = {
          ...base,
          content: [{ type: "text", text: "seven ducks" }],
          stopReason: "stop",
        };
      } else {
        parentTurn += 1;
        message =
          parentTurn === 1
            ? {
                ...base,
                content: [
                  {
                    type: "toolCall",
                    id: "call_1",
                    name: "task",
                    arguments: { agent: "scout", prompt: "Count the ducks." },
                  },
                ],
                stopReason: "toolUse",
              }
            : { ...base, content: [{ type: "text", text: "delegated" }], stopReason: "stop" };
      }
      queueMicrotask(() => {
        events.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return events;
    };
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: scripted,
      models: catalog,
      model,
      plugins: [
        inlinePlugin(systemPromptPlugin("base prompt")),
        inlinePlugin(toolsFsPlugin()),
        inlinePlugin(
          definePlugin({
            id: "scout-agent",
            session(api) {
              api.agents.add((draft) => {
                draft.set("scout", {
                  id: "scout",
                  mode: "subagent",
                  description: "Counts things.",
                  system: "You are Scout.",
                });
              });
            },
          }),
        ),
      ],
      env: { cwd },
    });
    const { sessionId: parentId } = await uji.sessions.create();
    const detach = uji.attach();

    await uji.messages.send({ sessionId: parentId, content: "count the ducks" });
    // A foreground delegation parks the parent, so `wait` may honestly answer
    // `waiting` while the child runs; done means idle.
    await until(
      async () => (await uji.runs.wait({ sessionId: parentId })).kind === "idle",
      "the delegation never completed",
    );

    // The parent's transcript settled the delegation with durable details.
    const turns = await uji.messages.list({ sessionId: parentId });
    const tool = turns
      .flatMap((turn) =>
        turn.kind === "turn"
          ? turn.parts.flatMap((part) => (part.kind === "tool" ? [part] : []))
          : [],
      )
      .find((part) => part.toolName === "task");
    assert.ok(tool, "the parent transcript has the task call");
    assert.equal(tool.result?.title, "scout");
    assert.equal(tool.result?.output.includes("seven ducks"), true);
    const details = tool.result?.details as {
      agent: string;
      childSessionId: string;
      state: string;
    };
    assert.equal(details.agent, "scout");
    assert.equal(details.state, "completed");
    const childId = details.childSessionId as SessionId;

    // The child is a real, durable, linked session.
    const child = await uji.sessions.get({ sessionId: childId });
    assert.equal(child?.parent?.sessionId, parentId);
    assert.equal(child?.parent?.agent, "scout");
    assert.equal(child?.parent?.depth, 1);
    assert.equal(child?.parent?.callId, "call_1");
    assert.equal(child?.config.agent, "scout");
    const parentStarted = (await replay(uji, parentId)).find(
      (event) => event.kind === "run_started",
    );
    assert.equal(
      child?.parent?.runId,
      parentStarted?.kind === "run_started" ? parentStarted.runId : undefined,
    );

    // Directory filters see it as a child, not a root.
    assert.deepEqual(
      (await uji.sessions.list({ parent: parentId })).items.map((info) => info.sessionId),
      [childId],
    );
    assert.equal(
      (await uji.sessions.list({ parent: null })).items.some((info) => info.sessionId === childId),
      false,
    );

    // The child ran as scout: persona layered, the full catalog, and no task.
    const childCall = captured.find((call) => call.sys.includes("You are Scout."));
    assert.ok(childCall, "the child reached the model");
    assert.equal(childCall.sys.includes("base prompt"), true);
    assert.equal(childCall.tools.includes("read"), true);
    assert.equal(childCall.tools.includes("write"), true);
    assert.equal(childCall.tools.includes("task"), false);
    assert.equal(captured[0]?.tools.includes("task"), true);

    // The child's own record: declared agent on its run, prompt, and answer.
    const childStarted = (await replay(uji, childId)).find((event) => event.kind === "run_started");
    assert.equal(childStarted?.kind === "run_started" ? childStarted.agent : undefined, "scout");
    const childTexts = (await uji.messages.list({ sessionId: childId })).flatMap((turn) =>
      turn.kind === "turn"
        ? turn.parts.flatMap((part) => (part.kind === "assistant" ? [part.text] : []))
        : [],
    );
    assert.deepEqual(childTexts, ["seven ducks"]);

    // The wake nudge never surfaces as conversation: the parent's user turns
    // are exactly what the user sent.
    const parentUserTexts = (await uji.messages.list({ sessionId: parentId })).flatMap((turn) =>
      turn.kind === "turn"
        ? turn.parts.flatMap((part) =>
            part.kind === "user" && typeof part.content === "string" ? [part.content] : [],
          )
        : [],
    );
    assert.deepEqual(parentUserTexts, ["count the ducks"]);

    detach();
    await uji.close();
    await store.close();
  });

  void test("a reload can introduce delegation to an already-open session", async () => {
    const toolsSeen: string[][] = [];
    const scripted: StreamFn = (_model, context) => {
      toolsSeen.push((context.tools ?? []).map((tool) => tool.name));
      const sys = context.systemPrompt ?? "";
      const messages = context.messages ?? [];
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const lastText =
        typeof lastUser?.content === "string"
          ? lastUser.content
          : (lastUser?.content ?? [])
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n");
      const events = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (event) => event.type === "done" || event.type === "error",
        (event) => {
          if (event.type === "done") return event.message;
          if (event.type === "error") return event.error;
          throw new Error("no terminal event");
        },
      );
      const base = {
        role: "assistant" as const,
        api: "openai-responses" as const,
        provider: "openai",
        model: "test-model",
        usage,
        timestamp: Date.now(),
      };
      const message: AssistantMessage = sys.includes("You are Scout.")
        ? { ...base, content: [{ type: "text", text: "seven ducks" }], stopReason: "stop" }
        : messages.some((entry) => entry.role === "toolResult")
          ? { ...base, content: [{ type: "text", text: "delegated" }], stopReason: "stop" }
          : lastText.includes("delegate")
            ? {
                ...base,
                content: [
                  {
                    type: "toolCall",
                    id: "call_reload",
                    name: "task",
                    arguments: { agent: "scout", prompt: "Count the ducks." },
                  },
                ],
                stopReason: "toolUse",
              }
            : { ...base, content: [{ type: "text", text: "hi" }], stopReason: "stop" };
      queueMicrotask(() => {
        events.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
      });
      return events;
    };
    const scoutAgents = definePlugin({
      id: "scout-agent",
      session(api) {
        api.agents.add((draft) => {
          draft.set("scout", {
            id: "scout",
            mode: "subagent",
            description: "Counts things.",
            system: "You are Scout.",
          });
        });
      },
    });
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: scripted,
      models: catalog,
      model,
      plugins: [inlinePlugin(systemPromptPlugin("base prompt")), inlinePlugin(toolsFsPlugin())],
      env: { cwd },
    });
    const { sessionId: parentId } = await uji.sessions.create();
    const detach = uji.attach();

    // Before the reload: no agents anywhere, so no task tool is offered.
    await uji.messages.send({ sessionId: parentId, content: "hello" });
    await uji.runs.wait({ sessionId: parentId });
    assert.equal(toolsSeen[0]?.includes("task"), false);

    // The reload, exactly as the TUI's /reload issues it: a fresh list that
    // now carries an agents plugin, applied to the open session.
    await uji.setPlugins([
      inlinePlugin(systemPromptPlugin("base prompt")),
      inlinePlugin(toolsFsPlugin()),
      inlinePlugin(scoutAgents),
    ]);

    await uji.messages.send({ sessionId: parentId, content: "delegate the counting" });
    await until(
      async () => (await uji.runs.wait({ sessionId: parentId })).kind === "idle",
      "the delegation never completed",
    );

    const delegating = toolsSeen.find((tools) => tools.includes("task"));
    assert.ok(delegating, "after the reload the model was offered task");
    const tool = (await uji.messages.list({ sessionId: parentId }))
      .flatMap((turn) =>
        turn.kind === "turn"
          ? turn.parts.flatMap((part) => (part.kind === "tool" ? [part] : []))
          : [],
      )
      .find((part) => part.toolName === "task");
    const details = tool?.result?.details as {
      agent: string;
      childSessionId: string;
      state: string;
    };
    assert.equal(details.state, "completed");
    const child = await uji.sessions.get({ sessionId: details.childSessionId as SessionId });
    assert.equal(child?.parent?.sessionId, parentId);
    assert.equal(child?.config.agent, "scout");

    detach();
    await uji.close();
    await store.close();
  });

  void test("runs.changes reports settled patches for the branch and for one run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "uji-sdk-"));
    directories.push(cwd);
    const store = new SqliteSessionRepo(join(cwd, "sessions.db"));
    const uji = await createUji({
      store,
      streamFn: writeThenStop(),
      models: catalog,
      model,
      plugins: [inlinePlugin(systemPromptPlugin("test")), inlinePlugin(toolsFsPlugin())],
      env: { cwd },
    });
    const { sessionId } = await uji.sessions.create();
    const detach = uji.attach();

    await uji.messages.send({ sessionId, content: "write it" });
    await uji.runs.wait({ sessionId });

    // The git panel's read: one file, its totals, no roundtrips beyond this.
    const changes = await uji.runs.changes({ sessionId });
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.path.endsWith("view.md"), true);
    assert.equal(changes[0]?.added, 1);
    assert.equal(changes[0]?.removed, 0);

    const finished = (await replay(uji, sessionId)).find((event) => event.kind === "run_finished");
    assert.equal(finished?.kind, "run_finished");
    if (finished?.kind === "run_finished") {
      assert.deepEqual(await uji.runs.changes({ sessionId, runId: finished.runId }), changes);
    }
    assert.deepEqual(await uji.runs.changes({ sessionId, runId: "missing" }), []);

    detach();
    await uji.close();
    await store.close();
  });
});
