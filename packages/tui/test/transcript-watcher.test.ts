import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createAssistantMessageEventStream, type Model } from "@uji-ai/ai";
import { AgentHarness, SqliteSessionRepo } from "@uji-ai/core";
import type { AssistantMessage, Usage } from "@uji-ai/schema";
import { shouldReloadTranscript, wireHarness } from "../src/interactive.ts";
import { watchSessionBranch } from "../src/session-observer.ts";
import { THEME } from "../src/theme.ts";
import { buildUi, ComposerStatus, replaceTranscript } from "../src/tui.ts";

const usage: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
  id: "transcript-test",
  name: "Transcript test",
  api: "openai-responses",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

void test("a delayed head move for a live turn does not rebuild its renderables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-tui-transcript-watcher-"));
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create({ id: "transcript-watcher" });
  const streamStarted = Promise.withResolvers<void>();
  const finishStream = Promise.withResolvers<void>();
  const { harness } = await AgentHarness.create({
    session,
    streamFn() {
      const stream = createAssistantMessageEventStream();
      const partial = assistant("");
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        partial.content = [{ type: "text", text: "live answer" }];
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "live answer",
          partial,
        });
        streamStarted.resolve();
        void finishStream.promise.then(() => {
          stream.push({ type: "done", reason: "stop", message: assistant("live answer") });
        });
      });
      return stream;
    },
    plugins: [],
    env: { cwd: directory },
    model,
  });
  const setup = await createTestRenderer({ width: 72, height: 30 });
  const ui = buildUi(setup.renderer, THEME);
  const status = new ComposerStatus(
    setup.renderer,
    ui.powerline,
    ui.transcript.theme,
    () => false,
    {
      runState: "idle",
      workspace: "test",
      dirty: false,
      model: model.id,
      statuses: [],
      queued: 0,
    },
  );
  let visible = true;
  const unsubscribe = wireHarness(ui, harness, status, directory, () => visible);
  const watcherReady = Promise.withResolvers<void>();
  const releaseWatcher = Promise.withResolvers<void>();
  const headMovesSeen = Promise.withResolvers<void>();
  let initial = true;
  let headMoves = 0;
  const stopWatching = watchSessionBranch(session, {
    head: "main",
    shouldReload(leafId) {
      const reload = shouldReloadTranscript(ui, harness, leafId);
      headMoves += 1;
      if (headMoves === 2) headMovesSeen.resolve();
      return reload;
    },
    async onBranch(entries) {
      if (initial) {
        initial = false;
        watcherReady.resolve();
        await releaseWatcher.promise;
        return;
      }
      replaceTranscript(ui, entries);
    },
    onError(error) {
      headMovesSeen.reject(error);
    },
  });

  try {
    await watcherReady.promise;
    const run = harness.prompt("hello");
    await streamStarted.promise;
    await setup.renderOnce();
    const liveChildren = ui.scroll.getChildren();
    assert.equal(liveChildren.length, 1);

    finishStream.resolve();
    const result = await run;
    assert.equal(result.ok, true);
    await setup.renderOnce();

    releaseWatcher.resolve();
    await headMovesSeen.promise;
    await setup.renderOnce();
    assert.equal(ui.renderedEntries.size, 0);
    assert.equal(shouldReloadTranscript(ui, harness, "foreign-entry"), true);
    const settledChildren = ui.scroll.getChildren();
    assert.equal(settledChildren.length, liveChildren.length);
    for (const [index, child] of settledChildren.entries()) {
      assert.equal(child, liveChildren[index]);
    }
  } finally {
    visible = false;
    releaseWatcher.resolve();
    stopWatching();
    unsubscribe();
    setup.renderer.destroy();
    await harness.close();
    await session.close();
    await repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("a steering note disappears when the steer becomes a user message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "uji-tui-steering-status-"));
  const repo = new SqliteSessionRepo(join(directory, "sessions.db"));
  const session = await repo.create({ id: "steering-status" });
  const firstStarted = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<void>();
  const finishSecond = Promise.withResolvers<void>();
  let call = 0;
  const { harness } = await AgentHarness.create({
    session,
    streamFn() {
      const stream = createAssistantMessageEventStream();
      const partial = assistant("");
      const current = call;
      call += 1;
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        const started = current === 0 ? firstStarted : secondStarted;
        const finish = current === 0 ? finishFirst : finishSecond;
        started.resolve();
        void finish.promise.then(() => {
          stream.push({ type: "done", reason: "stop", message: assistant("done") });
        });
      });
      return stream;
    },
    plugins: [],
    env: { cwd: directory },
    model,
  });
  const setup = await createTestRenderer({ width: 72, height: 30 });
  const ui = buildUi(setup.renderer, THEME);
  const status = new ComposerStatus(
    setup.renderer,
    ui.powerline,
    ui.transcript.theme,
    () => false,
    {
      runState: "idle",
      workspace: "test",
      dirty: false,
      model: model.id,
      statuses: [],
      queued: 0,
    },
  );
  let visible = true;
  const unsubscribe = wireHarness(ui, harness, status, directory, () => visible);
  const run = harness.prompt("first");

  try {
    await firstStarted.promise;
    const submitted = await harness.submit("interject");
    if (!submitted.ok || submitted.value.disposition !== "queued") {
      throw new Error("expected steering input to queue");
    }
    ui.steeringStatus.show(submitted.value.entryId, "interject");
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Steering: interject/u);

    finishFirst.resolve();
    await secondStarted.promise;
    await setup.renderOnce();
    const steeredFrame = setup.captureCharFrame();
    assert.doesNotMatch(steeredFrame, /Steering:/u);
    assert.equal(steeredFrame.match(/interject/gu)?.length, 1);

    finishSecond.resolve();
    const result = await run;
    assert.equal(result.ok, true);
  } finally {
    visible = false;
    finishFirst.resolve();
    finishSecond.resolve();
    unsubscribe();
    setup.renderer.destroy();
    await harness.close();
    await session.close();
    await repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
